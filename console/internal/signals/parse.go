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
	"encoding/json"
	"regexp"
	"strings"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/model"
)

// Slack message formats the kube-agents bot posts (see parse_test.go for
// real examples).
const (
	// Top-level alert markers: a critical crash alert and a warning card.
	emojiCritical = ":rotating_light:"
	emojiWarning  = ":large_yellow_circle:"
	emojiError    = ":red_circle:"
	emojiOrange   = ":large_orange_circle:"
	// emojiQuiet opens the event watcher's "quiet since" note in a thread.
	emojiQuiet = ":zzz:"
	// Task-card step markers: running, done, failed.
	markRunning = "◌"
	markDone    = "✓"
	markFailed  = "✗"
	// optionPrefix names a report option ("Option B").
	optionPrefix = "Option "
	// applyOptionSep joins a choice button's label and its option letter in
	// a report's text: "Increase to 64Mi with headroom — apply Option B".
	applyOptionSep = " — apply " + optionPrefix
	recommendedFmt = "Recommended: "
	// titleApply is the title of a person's "apply" reply.
	titleApply   = "Apply"
	blockActions = "actions"
	blockContext = "context"
	elemButton   = "button"
	stylePrimary = "primary"
	titleFixPR   = "Fix PR opened"
	ellipsis     = "…"
	// Slack HTML entities in message text.
	entityAmp = "&amp;"
	entityLt  = "&lt;"
	entityGt  = "&gt;"
)

var (
	// alertEmojis open a top-level message about a failing workload.
	alertEmojis = []string{emojiCritical, emojiWarning, emojiError, emojiOrange}
	// leadEmojiRe matches an emoji shortcode opening a message.
	leadEmojiRe = regexp.MustCompile(`^\s*:[a-z][a-z0-9_+'-]*:\s*`)
	// headingRe captures a bold heading opening a message (after an emoji).
	headingRe = regexp.MustCompile(`^\s*(?::[a-z][a-z0-9_+'-]*:\s*)?\*([^*\n]+)\*`)
	// crashRe reads "<workload> in <cluster> keeps crashing." from a heading.
	crashRe = regexp.MustCompile(`^([a-z0-9][a-z0-9.-]*) in ([a-z0-9][a-z0-9-]*[a-z0-9])\b`)
	// objectRe captures the first `namespace/name` in backticks.
	objectRe = regexp.MustCompile("`([a-z0-9][a-z0-9.-]*)/([a-z0-9][a-z0-9.-]*)`")
	// clusterRes read a cluster name: "on cluster <name>" (drift notes),
	// "on `<name>`" (quiet notes), "Triage ns/Kind/name (Reason) on <name>"
	// (task labels).
	clusterRes = []*regexp.Regexp{
		regexp.MustCompile(`\bon cluster ([a-z0-9][a-z0-9-]*[a-z0-9])\b`),
		regexp.MustCompile("\\bon `([a-z0-9][a-z0-9-]*[a-z0-9])`"),
		regexp.MustCompile(`^Triage \S+ \([^)]*\) on ([a-z0-9][a-z0-9-]*[a-z0-9])$`),
	}
	// crashLabelRe reads a crash triage label "<workload> crashloop in <cluster>".
	crashLabelRe = regexp.MustCompile(`^([a-z0-9][a-z0-9.-]*) crashloop in ([a-z0-9][a-z0-9-]*[a-z0-9])$`)
	// cardRe splits a task card "<label> ◌ <step>".
	cardRe = regexp.MustCompile(`(?s)^(.+?) (` + markRunning + `|` + markDone + `|` + markFailed + `) (.+)$`)
	// stepSuffixRe trims a card's "· step 2 ▸" progress suffix.
	stepSuffixRe = regexp.MustCompile(`\s*·\s*step \d+\s*▸?\s*$`)
	// applyLabelRe marks the task card the agent runs for a chosen fix.
	applyLabelRe = regexp.MustCompile(`(?i)^apply\b`)
	// applyReplyRe is a person's "apply" / "apply Option B" reply.
	applyReplyRe = regexp.MustCompile(`(?i)^\s*(?:@\S+\s+)?apply(?:\s+option\s+([a-z]))?\s*[.!]?\s*$`)
	// reportRe marks the Cluster Agent's report.
	reportRe = regexp.MustCompile(`\*What.s wrong\*|\*What to do\*`)
	// wrongRe captures the report's "What's wrong" section.
	wrongRe = regexp.MustCompile(`(?s)\*What.s wrong\*\s*(.+?)\s*(?:\*Why\*|\*What to do\*|$)`)
	// stateRe trims a leading "State at 18:03 UTC: ".
	stateRe = regexp.MustCompile(`^State at \d{1,2}:\d{2} UTC:\s*`)
	// optionRe captures "*Option A (Revert to working 32Mi):*".
	optionRe = regexp.MustCompile(`\*Option ([A-Z]) \(([^)]*)\):\*`)
	// recommendedRe captures "Recommended: Option B".
	recommendedRe = regexp.MustCompile(`Recommended:\*?\s*Option ([A-Z])`)
	// buttonOptionRe reads a choice button "<label> — apply Option B".
	buttonOptionRe = regexp.MustCompile(`^(.+?)\s+—\s+apply Option ([A-Z])$`)
	// chooserRe reads the context line a report gains when someone presses
	// an option: "✓ Gari Singh (google): Increase to 64Mi with headroom".
	chooserRe = regexp.MustCompile(`^` + markDone + `\s+(.+?):\s+(.+)$`)
	// orgSuffixRe trims a chooser's " (org)" suffix.
	orgSuffixRe = regexp.MustCompile(`\s+\([^)]*\)$`)
	// prLinkRe finds a pull request URL.
	prLinkRe = regexp.MustCompile(`https://github\.com/[\w.-]+/[\w.-]+/pull/\d+`)
	// Slack mrkdwn: links, mentions, emoji, emphasis.
	linkLabelRe = regexp.MustCompile(`<(?:https?://|mailto:)[^|>]*\|([^>]*)>`)
	linkBareRe  = regexp.MustCompile(`<((?:https?://|mailto:)[^|>]*)>`)
	channelRe   = regexp.MustCompile(`<#[A-Z0-9]+\|([^>]*)>`)
	specialRe   = regexp.MustCompile(`<!(here|channel|everyone)[^>]*>`)
	emojiRe     = regexp.MustCompile(`:[a-z][a-z0-9_+'-]*:`)
	italicRe    = regexp.MustCompile(`(^|[\s(])_([^_\n]+)_($|[\s.,;:)])`)
	spaceRe     = regexp.MustCompile(`\s+`)
	sentenceRe  = regexp.MustCompile(`[.!?](\s|$)`)
	// lineBreakRe treats Slack's flattened block text ("  ") as a line break.
	lineBreakRe = regexp.MustCompile(`\n| {2,}`)
)

// slackMessage is a message from conversations.history or .replies.
type slackMessage struct {
	TS          string       `json:"ts"`
	ThreadTS    string       `json:"thread_ts"`
	User        string       `json:"user"`
	BotID       string       `json:"bot_id"`
	Subtype     string       `json:"subtype"`
	Text        string       `json:"text"`
	ReplyCount  int          `json:"reply_count"`
	LatestReply string       `json:"latest_reply"`
	Edited      *slackEdited `json:"edited"`
	Blocks      []slackBlock `json:"blocks"`
	Attachments []struct {
		Blocks []slackBlock `json:"blocks"`
	} `json:"attachments"`
}

type slackEdited struct {
	TS string `json:"ts"`
}

// slackBlock is the part of a Block Kit block the classifier reads.
type slackBlock struct {
	Type     string         `json:"type"`
	Elements []slackElement `json:"elements"`
}

type slackElement struct {
	Type     string    `json:"type"`
	Text     slackText `json:"text"`
	Style    string    `json:"style"`
	URL      string    `json:"url"`
	ActionID string    `json:"action_id"`
}

// slackText is a text field that is a string (context elements) or a text
// object (buttons).
type slackText string

func (t *slackText) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		*t = slackText(s)
		return nil
	}
	var o struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(b, &o); err != nil {
		// A rich_text element's text can be anything; it isn't read.
		return nil
	}
	*t = slackText(o.Text)
	return nil
}

// allBlocks returns the message's blocks and its attachments' blocks.
func (m slackMessage) allBlocks() []slackBlock {
	out := append([]slackBlock{}, m.Blocks...)
	for _, a := range m.Attachments {
		out = append(out, a.Blocks...)
	}
	return out
}

// signal is one event a message yields, before the poller adds the thread,
// permalink, actor and key.
type signal struct {
	Type    string
	Title   string
	Message string
	// Cluster and Name are what the message itself names.
	Cluster string
	Name    string
	// Link overrides the message permalink (a PR URL).
	Link string
	// Actor overrides the message author (who pressed an option button).
	Actor string
	// TS overrides the message ts as the event time (an edit's ts).
	TS string
	// FromEdit marks a signal read from an edit rather than the post.
	FromEdit bool
	// Options are a report's choice buttons.
	Options []model.Option
}

// classify reads one message. reply says it is in a thread; bot says the
// kube-agents bot posted it. Mentions should already be expanded.
func classify(m slackMessage, reply, bot bool) []signal {
	text := m.Text
	if !reply {
		return []signal{classifyTop(text)}
	}
	if !bot {
		if sm := applyReplyRe.FindStringSubmatch(plain(text)); sm != nil {
			title := titleApply
			if sm[1] != "" {
				title += " " + optionPrefix + strings.ToUpper(sm[1])
			}
			return []signal{{Type: model.EventFixChosen, Title: title}}
		}
		return []signal{chat(text)}
	}
	if reportRe.MatchString(text) {
		return classifyReport(m)
	}
	if sm := cardRe.FindStringSubmatch(text); sm != nil && !strings.Contains(sm[1], "\n") {
		return []signal{classifyCard(sm[1], sm[3])}
	}
	if u := prLinkRe.FindString(text); u != "" {
		return []signal{{Type: model.EventTriage, Title: titleFixPR, Link: u, Message: clip(plain(text), maxMessage)}}
	}
	if strings.HasPrefix(strings.TrimSpace(text), emojiQuiet) {
		s := chat(text)
		s.Type = model.EventTriage
		s.Cluster = clusterIn(text)
		return []signal{s}
	}
	return []signal{chat(text)}
}

// classifyTop reads a top-level message: an alert, or chat (drift notes,
// reconciles, audit summaries, people's questions).
func classifyTop(text string) signal {
	s := chat(text)
	s.Cluster = clusterIn(firstLine(text))
	t := strings.TrimSpace(text)
	alert := false
	for _, e := range alertEmojis {
		if strings.HasPrefix(t, e) {
			alert = true
		}
	}
	if !alert {
		return s
	}
	s.Type = model.EventAlert
	if h := heading(text); h != "" {
		if sm := crashRe.FindStringSubmatch(h); sm != nil {
			s.Name, s.Cluster = sm[1], sm[2]
			return s
		}
	}
	if sm := objectRe.FindStringSubmatch(firstLine(text)); sm != nil {
		s.Name = sm[2]
	}
	return s
}

// classifyCard reads a task card "<label> <mark> <step>".
func classifyCard(label, step string) signal {
	label = plain(label)
	step = plain(stepSuffixRe.ReplaceAllString(step, ""))
	s := signal{Type: model.EventTriage, Title: clip(step, maxTitle), Message: clip(label+" "+step, maxMessage)}
	if sm := crashLabelRe.FindStringSubmatch(label); sm != nil {
		s.Name, s.Cluster = sm[1], sm[2]
	} else {
		s.Cluster = clusterIn(label)
	}
	if applyLabelRe.MatchString(label) {
		s.Type = model.EventFixChosen
		s.Title = clip(label, maxTitle)
	}
	return s
}

// classifyReport reads the Cluster Agent's report, and the choice recorded
// on it when someone pressed an option button.
func classifyReport(m slackMessage) []signal {
	text := m.Text
	title := ""
	if sm := wrongRe.FindStringSubmatch(text); sm != nil {
		title = firstSentence(stateRe.ReplaceAllString(plain(sm[1]), ""))
	}
	if title == "" {
		title = chat(text).Title
	}
	opts, rec := reportOptions(m)
	var lines []string
	for _, o := range opts {
		lines = append(lines, o.letter+": "+o.label)
	}
	if rec != "" {
		r := recommendedFmt + optionPrefix + rec
		for _, o := range opts {
			if o.letter == optionPrefix+rec && o.label != "" {
				r += " (" + o.label + ")"
			}
		}
		lines = append(lines, r)
	}
	var options []model.Option
	for _, o := range opts {
		letter := strings.TrimPrefix(o.letter, optionPrefix)
		options = append(options, model.Option{Letter: letter, Label: o.label, Recommended: letter == rec})
	}
	out := []signal{{
		Type:    model.EventTriageReport,
		Title:   clip(title, maxTitle),
		Message: clip(strings.Join(lines, "\n"), maxMessage),
		Options: options,
	}}
	if who, choice := chooser(m); who != "" {
		t := choice
		if i := strings.Index(text, choice+applyOptionSep); i >= 0 {
			if rest := text[i+len(choice+applyOptionSep):]; rest != "" {
				t = optionPrefix + rest[:1] + ": " + choice
			}
		}
		ts := m.TS
		if m.Edited != nil && m.Edited.TS != "" {
			ts = m.Edited.TS
		}
		out = append(out, signal{Type: model.EventFixChosen, Title: clip(t, maxTitle), Actor: who, TS: ts, FromEdit: true})
	}
	return out
}

type option struct{ letter, label string }

// reportOptions lists the report's options ("Option A", label) and the
// recommended letter: from the choice buttons while they are there (the
// primary one is recommended), else from the text.
func reportOptions(m slackMessage) ([]option, string) {
	var opts []option
	rec := ""
	for _, b := range m.allBlocks() {
		if b.Type != blockActions {
			continue
		}
		for _, e := range b.Elements {
			if e.Type != elemButton || e.URL != "" {
				continue
			}
			sm := buttonOptionRe.FindStringSubmatch(plain(string(e.Text)))
			if sm == nil {
				continue
			}
			opts = append(opts, option{optionPrefix + sm[2], sm[1]})
			if e.Style == stylePrimary {
				rec = sm[2]
			}
		}
	}
	if len(opts) == 0 {
		for _, sm := range optionRe.FindAllStringSubmatch(m.Text, -1) {
			opts = append(opts, option{optionPrefix + sm[1], plain(sm[2])})
		}
	}
	if rec == "" {
		if sm := recommendedRe.FindStringSubmatch(m.Text); sm != nil {
			rec = sm[1]
		}
	}
	return opts, rec
}

// chooser reads "✓ <who>: <choice>" from a report's context block.
func chooser(m slackMessage) (who, choice string) {
	for _, b := range m.allBlocks() {
		if b.Type != blockContext {
			continue
		}
		for _, e := range b.Elements {
			if sm := chooserRe.FindStringSubmatch(strings.TrimSpace(string(e.Text))); sm != nil {
				return orgSuffixRe.ReplaceAllString(sm[1], ""), sm[2]
			}
		}
	}
	return "", ""
}

// chat is a message that is none of the signals: Title is its heading or
// first sentence, Message the rest.
func chat(text string) signal {
	return signal{Type: model.EventChat, Title: clip(titleOf(text), maxTitle), Message: clip(plain(text), maxMessage)}
}

// titleOf is a message's bold heading (unless it is a label such as
// "*Warning:*"), else its first line's first sentence.
func titleOf(text string) string {
	if h := heading(text); h != "" && !strings.HasSuffix(h, ":") {
		return plain(h)
	}
	return firstSentence(plain(firstLine(text)))
}

func heading(text string) string {
	if sm := headingRe.FindStringSubmatch(text); sm != nil {
		return strings.TrimSpace(sm[1])
	}
	return ""
}

// firstLine is the text up to the first line break (or Slack's flattened
// double space).
func firstLine(text string) string {
	text = strings.TrimSpace(text)
	if loc := lineBreakRe.FindStringIndex(text); loc != nil {
		return text[:loc[0]]
	}
	return text
}

func firstSentence(s string) string {
	if loc := sentenceRe.FindStringIndex(s); loc != nil {
		return strings.TrimSpace(s[:loc[0]+1])
	}
	return strings.TrimSpace(s)
}

// clusterIn reads a cluster name (see clusterRes).
func clusterIn(s string) string {
	for _, re := range clusterRes {
		if sm := re.FindStringSubmatch(s); sm != nil {
			return sm[1]
		}
	}
	return ""
}

// plain turns Slack mrkdwn into one line of plain text.
func plain(s string) string {
	s = linkLabelRe.ReplaceAllString(s, "$1")
	s = linkBareRe.ReplaceAllString(s, "$1")
	s = channelRe.ReplaceAllString(s, "#$1")
	s = specialRe.ReplaceAllString(s, "@$1")
	s = leadEmojiRe.ReplaceAllString(s, "")
	s = emojiRe.ReplaceAllString(s, "")
	s = italicRe.ReplaceAllString(s, "$1$2$3")
	s = strings.NewReplacer("*", "", "`", "", "~", "").Replace(s)
	s = strings.NewReplacer(entityLt, "<", entityGt, ">", entityAmp, "&").Replace(s)
	return strings.TrimSpace(spaceRe.ReplaceAllString(s, " "))
}

// clip shortens s to n runes, ending in an ellipsis when cut, at a word
// boundary when one is in the second half.
func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	cut := string(r[:n-1])
	if i := strings.LastIndex(cut, " "); i > len(cut)/2 {
		cut = cut[:i]
	}
	return strings.TrimRight(cut, " ,;:—-") + ellipsis
}
