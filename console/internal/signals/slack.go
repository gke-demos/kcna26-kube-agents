// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package signals

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/model"
)

const (
	defaultSlackInterval = 5 * time.Second
	defaultSlackAPI      = "https://slack.com/api/"
	// slackLookback is the history loaded on start.
	slackLookback = 12 * time.Hour
	// slackThreadWindow is how recent a thread's activity must be for its
	// replies to be re-polled.
	slackThreadWindow = 2 * time.Hour
	// maxActiveThreads caps the threads re-polled.
	maxActiveThreads = 10
	// maxLoadThreads caps the threads whose replies are read on start.
	maxLoadThreads = 50
	// slackPageLimit is the page size for history and replies.
	slackPageLimit = 200
	// botActor is the Actor of everything the kube-agents bot posts.
	botActor = "kube-agents"

	methodAuthTest = "auth.test"
	methodHistory  = "conversations.history"
	methodReplies  = "conversations.replies"
	methodUserInfo = "users.info"
	// subtypeBot is the subtype of messages posted by a bot without a user.
	subtypeBot = "bot_message"
	// permalinkPath and permalinkThread build a message permalink from the
	// workspace URL auth.test returns.
	permalinkPath   = "archives/"
	permalinkMsg    = "/p"
	permalinkThread = "?thread_ts=%s&cid=%s"
	// slackTSFormat renders a time as a Slack ts (seconds.microseconds).
	slackTSFormat = "%d.%06d"
)

var (
	// postSubtypes are the message subtypes that are posts (the others are
	// joins, topic changes and the like).
	postSubtypes = map[string]bool{"": true, subtypeBot: true, "thread_broadcast": true, "file_share": true, "me_message": true}
	// mentionRe matches a user mention "<@U123>".
	mentionRe = regexp.MustCompile(`<@([A-Z0-9]+)(?:\|[^>]*)?>`)
)

// Slack polls the channel and its threads.
type Slack struct {
	o SlackOptions
	// api is the Web API base URL; client, lookback, window and now are
	// overridden in tests.
	api      string
	client   *http.Client
	lookback time.Duration
	window   time.Duration
	now      func() time.Time

	workspace string // "https://<workspace>.slack.com/"
	botUser   string
	seen      map[string]map[string]bool // ts -> signal types emitted
	threads   map[string]*thread
	users     map[string]string
	rr        int
}

// thread is what the poller knows about one thread.
type thread struct {
	ts          string
	cluster     string
	name        string
	replyCount  int
	latestReply string
	activity    time.Time
	fixChosen   bool
	prs         map[string]bool
}

// Run polls until ctx ends.
func (s *Slack) Run(ctx context.Context, e Emitter, r Resolver) error {
	s.reset()
	for {
		err := s.authTest(ctx)
		if err == nil {
			break
		}
		slog.Warn("slack: auth.test failed", "err", err)
		if err := sleep(ctx, s.o.Interval); err != nil {
			return err
		}
	}
	if err := s.load(ctx, e, r); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		slog.Warn("slack: initial load failed", "err", err)
	}
	t := time.NewTicker(s.o.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			if err := s.poll(ctx, e, r); err != nil && ctx.Err() == nil {
				slog.Warn("slack: poll failed", "err", err)
			}
		}
	}
}

func (s *Slack) reset() {
	s.seen = map[string]map[string]bool{}
	s.threads = map[string]*thread{}
	s.users = map[string]string{}
}

// load emits the last lookback of the channel, threads included, in time order.
func (s *Slack) load(ctx context.Context, e Emitter, r Resolver) error {
	msgs, err := s.history(ctx, s.now().Add(-s.lookback))
	if err != nil {
		return err
	}
	var evs []model.Event
	for _, m := range msgs {
		evs = append(evs, s.handle(ctx, m, nil, r)...)
	}
	parents := withReplies(msgs)
	if len(parents) > maxLoadThreads {
		parents = parents[len(parents)-maxLoadThreads:]
	}
	for _, p := range parents {
		got, err := s.refresh(ctx, p, r)
		if err != nil {
			return err
		}
		evs = append(evs, got...)
	}
	s.flush(e, evs, r)
	return nil
}

// poll emits new top-level messages and new or changed replies in the
// active threads: those whose reply count or latest reply moved, plus one
// more in turn so edits (a report gaining a choice) surface.
func (s *Slack) poll(ctx context.Context, e Emitter, r Resolver) error {
	msgs, err := s.history(ctx, s.now().Add(-s.window))
	if err != nil {
		return err
	}
	var evs []model.Event
	for _, m := range msgs {
		if s.seen[m.TS] == nil {
			evs = append(evs, s.handle(ctx, m, nil, r)...)
		}
	}
	active := s.active()
	done := map[string]bool{}
	for _, p := range withReplies(msgs) {
		th := s.threads[p.TS]
		if th == nil || !active[p.TS] || (th.replyCount == p.ReplyCount && th.latestReply == p.LatestReply) {
			continue
		}
		got, err := s.refresh(ctx, p, r)
		if err != nil {
			s.flush(e, evs, r)
			return err
		}
		evs = append(evs, got...)
		done[p.TS] = true
	}
	if ts := s.nextRoundRobin(active, done); ts != "" {
		got, err := s.refresh(ctx, slackMessage{TS: ts}, r)
		if err != nil {
			s.flush(e, evs, r)
			return err
		}
		evs = append(evs, got...)
	}
	s.flush(e, evs, r)
	return nil
}

// flush fills in the cluster and key of events emitted before their thread
// named the cluster (a warning alert names only namespace/name; its replies
// say "on <cluster>"), then emits them in time order.
func (s *Slack) flush(e Emitter, evs []model.Event, r Resolver) {
	for i, ev := range evs {
		th := s.threads[ev.Thread]
		if ev.Cluster != "" || th == nil || th.cluster == "" {
			continue
		}
		evs[i].Cluster = th.cluster
		evs[i].Key = resolveKey(r, th.cluster, th.name)
	}
	emit(e, evs)
}

// refresh reads a thread's replies and returns the events for what is new.
func (s *Slack) refresh(ctx context.Context, parent slackMessage, r Resolver) ([]model.Event, error) {
	replies, err := s.replies(ctx, parent.TS)
	if err != nil {
		return nil, err
	}
	th := s.thread(parent.TS)
	if parent.ReplyCount > 0 || parent.LatestReply != "" {
		th.replyCount, th.latestReply = parent.ReplyCount, parent.LatestReply
	}
	var evs []model.Event
	for _, m := range replies {
		if m.TS == parent.TS {
			continue
		}
		if t := tsTime(m.TS); t.After(th.activity) {
			th.activity = t
		}
		evs = append(evs, s.handle(ctx, m, th, r)...)
	}
	return evs, nil
}

// active is the set of threads to re-poll: the maxActiveThreads with the
// most recent activity inside the window.
func (s *Slack) active() map[string]bool {
	cut := s.now().Add(-s.window)
	var ths []*thread
	for _, th := range s.threads {
		if th.activity.After(cut) {
			ths = append(ths, th)
		}
	}
	sort.Slice(ths, func(i, j int) bool { return ths[i].activity.After(ths[j].activity) })
	if len(ths) > maxActiveThreads {
		ths = ths[:maxActiveThreads]
	}
	out := map[string]bool{}
	for _, th := range ths {
		out[th.ts] = true
	}
	return out
}

// nextRoundRobin picks the next active thread not refreshed this round.
func (s *Slack) nextRoundRobin(active, done map[string]bool) string {
	var ids []string
	for ts := range active {
		if !done[ts] {
			ids = append(ids, ts)
		}
	}
	if len(ids) == 0 {
		return ""
	}
	sort.Strings(ids)
	s.rr++
	return ids[s.rr%len(ids)]
}

func (s *Slack) thread(ts string) *thread {
	th := s.threads[ts]
	if th == nil {
		th = &thread{ts: ts, activity: tsTime(ts), prs: map[string]bool{}}
		s.threads[ts] = th
	}
	return th
}

// handle turns one message into events. A message seen before yields only
// what an edit added: a report (progress turned report) or a chosen fix.
func (s *Slack) handle(ctx context.Context, m slackMessage, th *thread, r Resolver) []model.Event {
	if !postSubtypes[m.Subtype] || m.TS == "" {
		return nil
	}
	reply := th != nil
	if !reply {
		// replyCount and latestReply stay as last read by refresh, so a new
		// thread's replies are fetched on the next poll.
		th = s.thread(m.TS)
		if t := tsTime(m.LatestReply); t.After(th.activity) {
			th.activity = t
		}
	}
	bot := m.BotID != "" || m.Subtype == subtypeBot || (s.botUser != "" && m.User == s.botUser)
	m.Text = s.expandMentions(ctx, m.Text)
	emitted := s.seen[m.TS]
	first := emitted == nil
	if first {
		emitted = map[string]bool{}
		s.seen[m.TS] = emitted
	}
	var evs []model.Event
	for _, sig := range classify(m, reply, bot) {
		if emitted[sig.Type] {
			continue
		}
		if !first && sig.Type != model.EventTriageReport && sig.Type != model.EventFixChosen {
			continue
		}
		emitted[sig.Type] = true
		typ := sig.Type
		if typ == model.EventFixChosen {
			if th.fixChosen && (sig.FromEdit || !first) {
				continue
			}
			if th.fixChosen {
				// The agent's own "Apply Option B" card after the choice.
				typ = model.EventTriage
			}
			th.fixChosen = true
		}
		if sig.Link != "" && reply {
			if th.prs[sig.Link] {
				continue
			}
			th.prs[sig.Link] = true
		}
		if sig.Cluster != "" && th.cluster == "" {
			th.cluster = sig.Cluster
		}
		if sig.Name != "" && (th.name == "" || !reply) {
			th.name = sig.Name
		}
		evs = append(evs, s.event(ctx, m, th, sig, typ, bot, r))
	}
	return evs
}

func (s *Slack) event(ctx context.Context, m slackMessage, th *thread, sig signal, typ string, bot bool, r Resolver) model.Event {
	ts := m.TS
	if sig.TS != "" {
		ts = sig.TS
	}
	ev := model.Event{
		Type:      typ,
		Time:      tsTime(ts),
		Title:     sig.Title,
		Message:   sig.Message,
		Link:      sig.Link,
		Actor:     sig.Actor,
		Thread:    th.ts,
		Cluster:   th.cluster,
		Text:      clip(m.Text, maxText),
		TS:        m.TS,
		Permalink: s.permalink(m.TS, th.ts),
		Options:   sig.Options,
	}
	if sig.Cluster != "" {
		ev.Cluster = sig.Cluster
	}
	name := th.name
	if sig.Name != "" {
		name = sig.Name
	}
	ev.Key = resolveKey(r, ev.Cluster, name)
	if ev.Link == "" {
		ev.Link = s.permalink(m.TS, th.ts)
	}
	if ev.Actor == "" {
		if bot {
			ev.Actor = botActor
		} else {
			ev.Actor = s.userName(ctx, m.User)
		}
	}
	return ev
}

// permalink builds a message link from the workspace URL.
func (s *Slack) permalink(ts, threadTS string) string {
	if s.workspace == "" {
		return ""
	}
	u := s.workspace + permalinkPath + s.o.Channel + permalinkMsg + strings.ReplaceAll(ts, ".", "")
	if threadTS != "" && threadTS != ts {
		u += fmt.Sprintf(permalinkThread, threadTS, s.o.Channel)
	}
	return u
}

// expandMentions replaces "<@U123>" with "@display name".
func (s *Slack) expandMentions(ctx context.Context, text string) string {
	return mentionRe.ReplaceAllStringFunc(text, func(m string) string {
		id := mentionRe.FindStringSubmatch(m)[1]
		if n := s.userName(ctx, id); n != "" {
			return "@" + n
		}
		return "@" + id
	})
}

// userName returns a user's display name (cached; the id when unknown).
func (s *Slack) userName(ctx context.Context, id string) string {
	if id == "" {
		return ""
	}
	if n, ok := s.users[id]; ok {
		return n
	}
	var out struct {
		User struct {
			Name     string `json:"name"`
			RealName string `json:"real_name"`
			Profile  struct {
				DisplayName string `json:"display_name"`
				RealName    string `json:"real_name"`
			} `json:"profile"`
		} `json:"user"`
	}
	if err := s.call(ctx, methodUserInfo, url.Values{"user": {id}}, &out); err != nil {
		slog.Debug("slack: users.info failed", "user", id, "err", err)
		return id
	}
	n := id
	for _, c := range []string{out.User.Profile.DisplayName, out.User.Profile.RealName, out.User.RealName, out.User.Name} {
		if c != "" {
			n = c
			break
		}
	}
	s.users[id] = n
	return n
}

func (s *Slack) authTest(ctx context.Context) error {
	var out struct {
		URL    string `json:"url"`
		UserID string `json:"user_id"`
	}
	if err := s.call(ctx, methodAuthTest, url.Values{}, &out); err != nil {
		return err
	}
	s.workspace, s.botUser = out.URL, out.UserID
	if s.workspace != "" && !strings.HasSuffix(s.workspace, "/") {
		s.workspace += "/"
	}
	return nil
}

// history returns the channel's top-level messages since oldest, oldest first.
func (s *Slack) history(ctx context.Context, oldest time.Time) ([]slackMessage, error) {
	q := url.Values{
		"channel": {s.o.Channel},
		"oldest":  {fmt.Sprintf(slackTSFormat, oldest.Unix(), oldest.Nanosecond()/int(time.Microsecond))},
		"limit":   {strconv.Itoa(slackPageLimit)},
	}
	msgs, err := s.pages(ctx, methodHistory, q)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(msgs, func(i, j int) bool { return tsLess(msgs[i].TS, msgs[j].TS) })
	return msgs, nil
}

// replies returns a thread's messages (the parent first), oldest first.
func (s *Slack) replies(ctx context.Context, ts string) ([]slackMessage, error) {
	q := url.Values{"channel": {s.o.Channel}, "ts": {ts}, "limit": {strconv.Itoa(slackPageLimit)}}
	msgs, err := s.pages(ctx, methodReplies, q)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(msgs, func(i, j int) bool { return tsLess(msgs[i].TS, msgs[j].TS) })
	return msgs, nil
}

// pages follows a cursor-paginated method to the end.
func (s *Slack) pages(ctx context.Context, method string, q url.Values) ([]slackMessage, error) {
	var all []slackMessage
	for {
		var out struct {
			Messages []slackMessage `json:"messages"`
			Meta     struct {
				NextCursor string `json:"next_cursor"`
			} `json:"response_metadata"`
		}
		if err := s.call(ctx, method, q, &out); err != nil {
			return nil, err
		}
		all = append(all, out.Messages...)
		if out.Meta.NextCursor == "" {
			return all, nil
		}
		q.Set("cursor", out.Meta.NextCursor)
	}
}

// call invokes a Web API method and decodes its result into out.
func (s *Slack) call(ctx context.Context, method string, q url.Values, out any) error {
	resp, err := do(ctx, s.client, s.api+method+"?"+q.Encode(), s.o.Token, nil)
	if err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	if resp.status != http.StatusOK {
		return fmt.Errorf("%s: HTTP %d", method, resp.status)
	}
	var env struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(resp.body, &env); err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	if !env.OK {
		return fmt.Errorf("%s: %s", method, env.Error)
	}
	return json.Unmarshal(resp.body, out)
}

// withReplies returns the messages that have threads, oldest first.
func withReplies(msgs []slackMessage) []slackMessage {
	var out []slackMessage
	for _, m := range msgs {
		if m.ReplyCount > 0 {
			out = append(out, m)
		}
	}
	return out
}

// emit publishes events in time order.
func emit(e Emitter, evs []model.Event) {
	if len(evs) == 0 {
		return
	}
	sort.SliceStable(evs, func(i, j int) bool { return evs[i].Time.Before(evs[j].Time) })
	e.Emit(evs...)
}

// tsTime converts a Slack ts ("1793641808.988429") to a time.
func tsTime(ts string) time.Time {
	sec, frac, _ := strings.Cut(ts, ".")
	n, err := strconv.ParseInt(sec, 10, 64)
	if err != nil {
		return time.Time{}
	}
	us, _ := strconv.ParseInt(frac, 10, 64)
	return time.Unix(n, us*int64(time.Microsecond)).UTC()
}

func tsLess(a, b string) bool { return tsTime(a).Before(tsTime(b)) }
