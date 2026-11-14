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
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/model"
)

const (
	testChannel = "C0CEZ07K39N"
	incidentTS  = "1793641808.988429"
)

// fakeSlack serves the Web API methods the poller calls.
type fakeSlack struct {
	mu        sync.Mutex
	top       []slackMessage
	replies   map[string][]slackMessage
	throttle  int // 429s to return before the next replies call succeeds
	calls     map[string]int
	authToken string
}

func (f *fakeSlack) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	method := strings.TrimPrefix(r.URL.Path, "/")
	f.calls[method]++
	if r.Header.Get("Authorization") != "Bearer "+f.authToken {
		fmt.Fprint(w, `{"ok":false,"error":"invalid_auth"}`)
		return
	}
	var out map[string]any
	switch method {
	case methodAuthTest:
		out = map[string]any{"ok": true, "url": "https://kubeagentsdemo.slack.com/", "user_id": "U0CE6TMT88H"}
	case methodHistory:
		oldest := tsTime(r.URL.Query().Get("oldest"))
		var msgs []slackMessage
		for _, m := range f.top {
			if tsTime(m.TS).After(oldest) {
				msgs = append(msgs, m)
			}
		}
		out = map[string]any{"ok": true, "messages": msgs}
	case methodReplies:
		if f.throttle > 0 {
			f.throttle--
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		out = map[string]any{"ok": true, "messages": f.replies[r.URL.Query().Get("ts")]}
	case methodUserInfo:
		out = map[string]any{"ok": true, "user": map[string]any{"profile": map[string]any{"display_name": "Gari"}}}
	default:
		out = map[string]any{"ok": false, "error": "unknown_method"}
	}
	_ = json.NewEncoder(w).Encode(out)
}

// set replaces the incident thread's top-level message and replies.
func (f *fakeSlack) set(parent slackMessage, replies []slackMessage) {
	f.mu.Lock()
	defer f.mu.Unlock()
	parent.ReplyCount = len(replies)
	if len(replies) > 0 {
		parent.LatestReply = replies[len(replies)-1].TS
	}
	f.top = []slackMessage{parent}
	f.replies = map[string][]slackMessage{parent.TS: append([]slackMessage{parent}, replies...)}
}

type recorder struct{ evs []model.Event }

func (r *recorder) Emit(evs ...model.Event) []model.Event {
	r.evs = append(r.evs, evs...)
	return evs
}

func (r *recorder) take() []model.Event {
	out := r.evs
	r.evs = nil
	return out
}

// resolveAll says every workload is drawn.
func resolveAll(cluster, name string) (string, bool) { return model.Key(cluster, name), true }

func newTestSlack(t *testing.T) (*Slack, *fakeSlack) {
	t.Helper()
	f := &fakeSlack{calls: map[string]int{}, authToken: "xoxb-test"}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	s := NewSlack(SlackOptions{Token: "xoxb-test", Channel: testChannel})
	s.api = srv.URL + "/"
	// An hour after the incident's report.
	s.now = func() time.Time { return tsTime("1793646000.000000") }
	s.reset()
	if err := s.authTest(context.Background()); err != nil {
		t.Fatal(err)
	}
	return s, f
}

func types(evs []model.Event) []string {
	var out []string
	for _, e := range evs {
		out = append(out, e.Type)
	}
	return out
}

// TestSlackIncidentThread loads the real recommendationservice thread.
func TestSlackIncidentThread(t *testing.T) {
	s, f := newTestSlack(t)
	msgs := loadReplies(t)
	f.set(msgs[0], msgs[1:])
	f.throttle = 1
	rec := &recorder{}
	if err := s.load(context.Background(), rec, resolveAll); err != nil {
		t.Fatal(err)
	}
	evs := rec.take()
	want := []string{
		model.EventAlert,
		model.EventTriage, model.EventTriage, model.EventTriage, // progress notes
		model.EventTriage,       // ✓ State at 18:03 card
		model.EventTriageReport, // the report
		model.EventFixChosen,    // Gari pressed Option B (the report's edit)
		model.EventChat,         // "checking recommendationservice."
		model.EventTriage,       // the agent's Apply Option B card
		model.EventTriage,       // Fix PR opened (the second PR link is dropped)
		model.EventTriage,       // quiet since 18:25
	}
	if got := types(evs); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("types\n%v\nwant\n%v", got, want)
	}
	for i, e := range evs {
		if e.Thread != incidentTS || e.Cluster != "boutique-prod" || e.Key != "boutique-prod/recommendationservice" {
			t.Errorf("event %d: thread %q cluster %q key %q", i, e.Thread, e.Cluster, e.Key)
		}
		if i > 0 && e.Time.Before(evs[i-1].Time) {
			t.Errorf("event %d out of order", i)
		}
	}
	if got := evs[0].Link; got != "https://kubeagentsdemo.slack.com/archives/C0CEZ07K39N/p1793641808988429" {
		t.Errorf("alert link %q", got)
	}
	if got := evs[1].Link; got != "https://kubeagentsdemo.slack.com/archives/C0CEZ07K39N/p1793642380667739?thread_ts=1793641808.988429&cid=C0CEZ07K39N" {
		t.Errorf("reply link %q", got)
	}
	fix := evs[6]
	if fix.Actor != "Gari Singh" || !fix.Time.Equal(tsTime("1793643325.000000")) {
		t.Errorf("fix %+v", fix)
	}
	if evs[9].Link != "https://github.com/gke-demos/kcna26-fleet-gitops/pull/1" || evs[9].Actor != botActor {
		t.Errorf("PR note %+v", evs[9])
	}
	if f.calls[methodReplies] != 2 {
		t.Errorf("replies called %d times, want 2 (one 429)", f.calls[methodReplies])
	}

	// Nothing changed: nothing new, however many polls.
	for range maxActiveThreads + 1 {
		if err := s.poll(context.Background(), rec, resolveAll); err != nil {
			t.Fatal(err)
		}
	}
	if evs := rec.take(); len(evs) != 0 {
		t.Errorf("re-poll emitted %v", types(evs))
	}
}

// TestSlackEdits follows the thread live: the report posted with buttons,
// then edited when Gari presses Option B, then the agent's card.
func TestSlackEdits(t *testing.T) {
	s, f := newTestSlack(t)
	msgs := loadReplies(t)
	parent := msgs[0]
	report := findTS(t, msgs, reportTS)
	posted := report
	posted.Edited = nil
	posted.Blocks = []slackBlock{{Type: blockActions, Elements: []slackElement{
		{Type: elemButton, Text: "Revert to working 32Mi — apply Option A"},
		{Type: elemButton, Text: "Increase to 64Mi with headroom — apply Option B", Style: stylePrimary},
	}}}
	progress := slackMessage{TS: "1793642451.332189", ThreadTS: incidentTS, User: "U0CE6TMT88H", BotID: "B1",
		Text: "recommendationservice crashloop in boutique-prod ◌ Identified that revision 3 is OOMKilled."}
	f.set(parent, []slackMessage{progress, posted})
	rec := &recorder{}
	if err := s.load(context.Background(), rec, resolveAll); err != nil {
		t.Fatal(err)
	}
	if got := types(rec.take()); strings.Join(got, ",") != "alert,triage,triage_report" {
		t.Fatalf("load: %v", got)
	}

	// The progress note is edited (same ts, new text): one note with the new
	// text, timed at the edit, found by the round-robin re-read without a
	// reply-count change. A second poll adds nothing.
	edited := progress
	edited.Text = "recommendationservice crashloop in boutique-prod ◌ Identified that revision 3 is OOMKilled at 20Mi."
	edited.Edited = &slackEdited{TS: "1793642460.000000"}
	f.set(parent, []slackMessage{edited, posted})
	for range 2 {
		if err := s.poll(context.Background(), rec, resolveAll); err != nil {
			t.Fatal(err)
		}
	}
	if evs := rec.take(); len(evs) != 1 || evs[0].Type != model.EventTriage ||
		evs[0].Title != "Identified that revision 3 is OOMKilled at 20Mi." || !evs[0].Time.Equal(tsTime("1793642460.000000")) {
		t.Fatalf("edited progress emitted %+v", evs)
	}

	// Gari presses Option B; the agent posts its card.
	card := findTS(t, msgs, "1793643349.096569")
	f.set(parent, []slackMessage{edited, report, card})
	if err := s.poll(context.Background(), rec, resolveAll); err != nil {
		t.Fatal(err)
	}
	evs := rec.take()
	if got := types(evs); strings.Join(got, ",") != "fix_chosen,triage" {
		t.Fatalf("after choice: %v", got)
	}
	if evs[0].Actor != "Gari Singh" || evs[0].Title != "Option B: Increase to 64Mi with headroom" {
		t.Errorf("fix %+v", evs[0])
	}
}

// TestSlackProgressTurnsReport: an edit that turns a note into the report
// emits the report once.
func TestSlackProgressTurnsReport(t *testing.T) {
	s, f := newTestSlack(t)
	parent := loadReplies(t)[0]
	note := slackMessage{TS: "1793642600.000001", User: "U0CE6TMT88H", BotID: "B1",
		Text: "recommendationservice crashloop in boutique-prod ◌ Writing the report."}
	f.set(parent, []slackMessage{note})
	rec := &recorder{}
	if err := s.load(context.Background(), rec, resolveAll); err != nil {
		t.Fatal(err)
	}
	rec.take()
	note.Text = "*What's wrong*  State at 18:03 UTC: The pod is OOMKilled.  *What to do*  • *Option A (Revert to 32Mi):* Revert."
	note.Edited = &slackEdited{TS: "1793642700.000000"}
	f.set(parent, []slackMessage{note})
	for range 2 {
		if err := s.poll(context.Background(), rec, resolveAll); err != nil {
			t.Fatal(err)
		}
	}
	evs := rec.take()
	if got := types(evs); strings.Join(got, ",") != "triage_report" {
		t.Fatalf("got %v", got)
	}
	if evs[0].Title != "The pod is OOMKilled." || evs[0].Message != "Option A: Revert to 32Mi" {
		t.Errorf("report %+v", evs[0])
	}
}

// TestSlackAlertEditedIntoReport: kube-agents 0.25 under spec.mode next
// (captured from the staging install, 2026-11-07, shortened) edits the alert
// into the triage report and edits each task card in place.
func TestSlackAlertEditedIntoReport(t *testing.T) {
	s, f := newTestSlack(t)
	s.now = func() time.Time { return tsTime("1794082700.000000") }
	const alertTS, triageTS, prCardTS = "1794082403.984889", "1794082434.069509", "1794082495.336949"
	const label = "Triage online-boutique/Pod/checkoutservice-56744697df-dp6kr (Failed) on boutique-stg"
	alert := slackMessage{TS: alertTS, BotID: "B1", ReplyCount: 2, LatestReply: prCardTS,
		Text: ":large_yellow_circle: *Warning:* Failed `online-boutique/checkoutservice` — Failed to pull image \"checkoutservice:v0.10.70\": not found"}
	triage := slackMessage{TS: triageTS, ThreadTS: alertTS, BotID: "B1", Text: label + " ◌ " + label}
	prCard := slackMessage{TS: prCardTS, ThreadTS: alertTS, BotID: "B1",
		Text: "Open GitOps PR for online-boutique/Pod/checkoutservice-56744697df-dp6kr (Failed) on boutique-stg ◌ Open GitOps PR"}
	f.set(alert, []slackMessage{triage, prCard})
	rec := &recorder{}
	if err := s.load(context.Background(), rec, resolveAll); err != nil {
		t.Fatal(err)
	}
	if got := types(rec.take()); strings.Join(got, ",") != "alert,triage,triage" {
		t.Fatalf("load: %v", got)
	}

	// The triage finishes: its card and the alert are edited; no reply is added.
	report := alert
	report.Text = "*State at 20:14 UTC: The checkoutservice deployment's new Pod is stuck in ErrImagePull.*  *What's wrong*  " +
		"State at 20:14 UTC: The checkoutservice deployment's new Pod is stuck in ErrImagePull because the image tag v0.10.70 cannot be found. " +
		"More detail.  *Why*  • The deployment moved to v0.10.70."
	report.Edited = &slackEdited{TS: "1794082580.000000"}
	done := triage
	done.Text = label + " ✓ State at 20:14 UTC: checkoutservice-56744697df-dp6kr is stuck in ErrImagePull. Proposed fix is to revert the image tag."
	done.Edited = &slackEdited{TS: "1794082494.000000"}
	f.set(report, []slackMessage{done, prCard})
	for range 3 {
		if err := s.poll(context.Background(), rec, resolveAll); err != nil {
			t.Fatal(err)
		}
	}
	evs := rec.take()
	// In time order: the card's edit, then the alert's (the report).
	if got := types(evs); strings.Join(got, ",") != "triage,triage_report" {
		t.Fatalf("after the edits: %v", got)
	}
	note, rep := evs[0], evs[1]
	if rep.Thread != alertTS || rep.TS != alertTS || rep.Key != "boutique-stg/checkoutservice" || !rep.Time.Equal(tsTime("1794082580.000000")) ||
		rep.Title != "The checkoutservice deployment's new Pod is stuck in ErrImagePull because the image tag v0.10.70 cannot be found." {
		t.Errorf("report %+v", rep)
	}
	if note.TS != triageTS || !note.Time.Equal(tsTime("1794082494.000000")) || !strings.HasPrefix(note.Title, "State at 20:14 UTC: checkoutservice") {
		t.Errorf("note %+v", note)
	}

	// Nothing changes: nothing new.
	for range 2 {
		if err := s.poll(context.Background(), rec, resolveAll); err != nil {
			t.Fatal(err)
		}
	}
	if evs := rec.take(); len(evs) != 0 {
		t.Fatalf("idle polls emitted %v", types(evs))
	}
}

// TestSlackEditedTopLevelChatIsNotAReport: an edited top-level message
// without "What's wrong" (an audit card's "What to do") stays chat.
// TestNewCardFirstPost: kube-agents 0.31 posts a task card first as the running
// mark and the step alone (staging, 2026-11-14), where 0.25 posted
// "<label> ◌ <label>". Both read as the same triage note.
func TestNewCardFirstPost(t *testing.T) {
	const label = "Triage online-boutique/Pod/productcatalogservice-6bff8fffb9-w59ff (Failed) on boutique-stg"
	for _, text := range []string{"◌ " + label, label + " ◌ " + label} {
		got := classify(slackMessage{TS: "1794656439.921559", BotID: "B1", Text: text}, true, true)
		if len(got) != 1 || got[0].Type != model.EventTriage || got[0].Title != label || got[0].Cluster != "boutique-stg" {
			t.Errorf("%q: %+v", text, got)
		}
	}
	// A crash-loop card names its workload and cluster in the label.
	got := classify(slackMessage{TS: "1", BotID: "B1", Text: "◌ node-exporter crashloop in ap-iap-testing"}, true, true)
	if len(got) != 1 || got[0].Type != model.EventTriage || got[0].Name != "node-exporter" || got[0].Cluster != "ap-iap-testing" {
		t.Errorf("crashloop card: %+v", got)
	}
	// A recorded choice keeps its own reading.
	if got := classify(slackMessage{TS: "1", BotID: "B1", Text: "✓ Gari Singh: Increase to 64Mi"}, true, true); len(got) == 1 && got[0].Type == model.EventTriage && got[0].Title == "Gari Singh: Increase to 64Mi" {
		t.Errorf("choice line read as a new card: %+v", got)
	}
}

func TestSlackEditedTopLevelChatIsNotAReport(t *testing.T) {
	m := slackMessage{TS: "1794082000.000000", BotID: "B1", Edited: &slackEdited{TS: "1794082100.000000"},
		Text: ":clipboard: *Compliance audit*  *What to do*  • Review the findings."}
	if got := classify(m, false, true); len(got) != 1 || got[0].Type == model.EventTriageReport {
		t.Fatalf("got %+v", got)
	}
}

// TestSlackNewThreadAndPeople: a new alert with replies arrives between
// polls; a person's question and "apply" reply carry their name.
func TestSlackNewThreadAndPeople(t *testing.T) {
	s, f := newTestSlack(t)
	rec := &recorder{}
	if err := s.load(context.Background(), rec, resolveAll); err != nil {
		t.Fatal(err)
	}
	alert := slackMessage{TS: "1793645900.000100", User: "U0CE6TMT88H", BotID: "B1",
		Text: ":rotating_light: *cartservice in boutique-prod keeps crashing.* Looking now."}
	ask := slackMessage{TS: "1793645950.000100", ThreadTS: alert.TS, User: "UHUMAN",
		Text: "<@U0CE6TMT88H> apply Option A"}
	f.set(alert, []slackMessage{ask})
	if err := s.poll(context.Background(), rec, func(c, n string) (string, bool) { return "", false }); err != nil {
		t.Fatal(err)
	}
	evs := rec.take()
	if got := types(evs); strings.Join(got, ",") != "alert,fix_chosen" {
		t.Fatalf("got %v", got)
	}
	if evs[0].Key != "" || evs[0].Cluster != "boutique-prod" {
		t.Errorf("unresolved alert %+v", evs[0])
	}
	if evs[1].Actor != "Gari" || evs[1].Title != "Apply Option A" {
		t.Errorf("fix %+v", evs[1])
	}
}

// TestSlackBackfillCluster: a warning alert names namespace/name only; the
// thread's first triage card names the cluster, and the alert gets it too.
func TestSlackBackfillCluster(t *testing.T) {
	s, f := newTestSlack(t)
	alert := slackMessage{TS: "1793645106.129949", User: "U0CE6TMT88H", BotID: "B1",
		Text: ":large_yellow_circle: *Warning:* Failed `kube-system/gke-metrics-agent` — Error: host IP unknown\n:seedling: _Digging down to the root cause..._"}
	card := slackMessage{TS: "1793645136.699189", ThreadTS: alert.TS, User: "U0CE6TMT88H", BotID: "B1",
		Text: "Triage kube-system/Pod/gke-metrics-agent-9stkr (Failed) on kube-agents-hub ◌ Triage kube-system/Pod/gke-metrics-agent-9stkr (Failed) on kube-agents-hub"}
	f.set(alert, []slackMessage{card})
	rec := &recorder{}
	if err := s.load(context.Background(), rec, resolveAll); err != nil {
		t.Fatal(err)
	}
	evs := rec.take()
	if got := strings.Join(types(evs), ","); got != "alert,triage" {
		t.Fatalf("got %s", got)
	}
	for _, e := range evs {
		if e.Cluster != "kube-agents-hub" || e.Key != "kube-agents-hub/gke-metrics-agent" {
			t.Errorf("%s: cluster %q key %q", e.Type, e.Cluster, e.Key)
		}
	}
}
