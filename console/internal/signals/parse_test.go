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
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/model"
)

// Real messages from the demo channel (2026-11-02).
func TestClassify(t *testing.T) {
	cases := []struct {
		name    string
		text    string
		reply   bool
		bot     bool
		typ     string
		title   string
		cluster string
		wl      string
		link    string
	}{
		{
			name: "crash alert", bot: true,
			text:    ":rotating_light: *recommendationservice in boutique-prod keeps crashing.* Looking now.",
			typ:     model.EventAlert,
			title:   "recommendationservice in boutique-prod keeps crashing.",
			cluster: "boutique-prod", wl: "recommendationservice",
		},
		{
			name: "warning alert", bot: true,
			text:  ":large_yellow_circle: *Warning:* Failed `kube-system/node-local-dns` — Error: services have not yet been read at least once, cannot construct envvars\n:seedling: _Digging down to the root cause..._",
			typ:   model.EventAlert,
			title: "Warning: Failed kube-system/node-local-dns — Error: services have not yet been read at least once, cannot construct…",
			wl:    "node-local-dns",
		},
		{
			name: "drift", bot: true,
			text:    ":twisted_rightwards_arrows: *Drift:* <mailto:garisingh@google.com|garisingh@google.com> patched customresourcedefinitions/platformagents.kubeagents.x-k8s.io on cluster kube-agents-hub, fields owned by kubectl, kube-apiserver, terraform-provider-helm_v3.3.0_x5\n:seedling: _Checking what the cluster looks like now..._",
			typ:     model.EventChat,
			title:   "Drift: garisingh@google.com patched customresourcedefinitions/platformagents.kubeagents.x-k8s.io on cluster…",
			cluster: "kube-agents-hub",
		},
		{
			name: "reconcile", bot: true,
			text:  ":wrench: *Cluster Agent reconcile*\n  :heavy_plus_sign: created 3 profile(s): `cluster-kcna-2026-demos-bank-prod-us-central1-b`",
			typ:   model.EventChat,
			title: "Cluster Agent reconcile",
		},
		{
			name: "drift backlog", bot: true,
			text:  ":card_index_dividers: *Drift backlog:* 97 changes reached drift detection late (they queued before it started pulling, or waited over 30 minutes), so they are listed here instead of triaged one card each.\nBy principal:",
			typ:   model.EventChat,
			title: "Drift backlog: 97 changes reached drift detection late (they queued before it started pulling, or waited over 30…",
		},
		{
			name: "audit summary", bot: true,
			text:  "*Workload Reliability Audit: 1 critical finding* `critical` blocking-pdb on PodDisruptionBudget/ledger-db 59 more (22 major, 37 minor) are in the ledger issue. <https://github.com/gke-demos/kcna26-fleet-gitops/issues/4|Ledger issue #4 :arrow_upper_right:>",
			typ:   model.EventChat,
			title: "Workload Reliability Audit: 1 critical finding",
		},
		{
			name: "progress note", reply: true, bot: true,
			text:    "recommendationservice crashloop in boutique-prod ◌ Identified that recommendationservice has two replicasets running: revision 2 is running and healthy (memory limit 32Mi), while revision 3 is crash-looping with OOMKilled (memory limit 20Mi).",
			typ:     model.EventTriage,
			title:   "Identified that recommendationservice has two replicasets running: revision 2 is running and healthy (memory limit…",
			cluster: "boutique-prod", wl: "recommendationservice",
		},
		{
			name: "progress note with step suffix", reply: true, bot: true,
			text:  "recommendationservice crashloop in boutique-prod ◌ Found that recommendationservice-659fd87c86-c7xjn (rev 3) has memory limits of 20Mi… · step 2 ▸",
			typ:   model.EventTriage,
			title: "Found that recommendationservice-659fd87c86-c7xjn (rev 3) has memory limits of 20Mi…",
		},
		{
			name: "triage label names the cluster", reply: true, bot: true,
			text:    "Triage kube-system/Pod/gke-metrics-agent-9stkr (Failed) on kube-agents-hub ◌ Read-only diagnostics complete: verified kube-system/Pod/gke-metrics-agent-9stkr is running, healthy, and fully ready with zero restarts. Preparing final report.",
			typ:     model.EventTriage,
			title:   "Read-only diagnostics complete: verified kube-system/Pod/gke-metrics-agent-9stkr is running, healthy, and fully ready…",
			cluster: "kube-agents-hub",
		},
		{
			name: "state card", reply: true, bot: true,
			text:  "github-token-minter crashloop in kube-agents-hub ✓ State at 17:46 UTC: github-token-minter has recovered and is healthy.",
			typ:   model.EventTriage,
			title: "State at 17:46 UTC: github-token-minter has recovered and is healthy.",
		},
		{
			name: "report", reply: true, bot: true,
			text:  "*What's wrong*  State at 18:45 UTC: kube-system/Pod/gke-metrics-agent-9stkr has fully recovered and is healthy, and the reported 'Error: host IP unknown' warnings were transient initialization events that have resolved themselves.  *Why*  • *Workload Is Healthy:* A live read",
			typ:   model.EventTriageReport,
			title: "kube-system/Pod/gke-metrics-agent-9stkr has fully recovered and is healthy, and the reported 'Error: host IP unknown'…",
		},
		{
			name: "agent's apply card", reply: true, bot: true,
			text:  "Apply Option B: Increase recommendationservice memory to 64Mi ✓ Opened Pull Request #1 in gke-demos/kcna26-fleet-gitops to increase recommendationservice memory to 64Mi.",
			typ:   model.EventFixChosen,
			title: "Apply Option B: Increase recommendationservice memory to 64Mi",
		},
		{
			name: "person types apply", reply: true,
			text:  "apply Option b",
			typ:   model.EventFixChosen,
			title: "Apply Option B",
		},
		{
			name: "person mentions the bot and applies", reply: true,
			text:  "@kubeagents apply",
			typ:   model.EventFixChosen,
			title: "Apply",
		},
		{
			name: "PR link", reply: true, bot: true,
			text:  "I opened PR #1 in kcna26-fleet-gitops. It's yours to review. chore(online-boutique): increase recommendationservice memory requests and limits to 64Mi <https://github.com/gke-demos/kcna26-fleet-gitops/pull/1>",
			typ:   model.EventTriage,
			title: titleFixPR,
			link:  "https://github.com/gke-demos/kcna26-fleet-gitops/pull/1",
		},
		{
			name: "quiet note", reply: true, bot: true,
			text:    ":zzz: *Quiet since 18:25 UTC:* no new `Crash loop back off` events from `online-boutique/recommendationservice-659fd87c86-c7xjn` on `boutique-prod` for 15 min (first at 17:44 UTC, 11 seen). Read off events alone: the object was not re-read.",
			typ:     model.EventTriage,
			title:   "Quiet since 18:25 UTC: no new Crash loop back off events from online-boutique/recommendationservice-659fd87c86-c7xjn…",
			cluster: "boutique-prod",
		},
		{
			name: "bot ack", reply: true, bot: true,
			text:  "checking recommendationservice.",
			typ:   model.EventChat,
			title: "checking recommendationservice.",
		},
		{
			name: "bot answer", reply: true, bot: true,
			text:  "*The first critical finding from the Workload Reliability Audit report is that the `ledger-db` database's PodDisruptionBudget is configured to completely block node drains.* In the <https://github.com/gke-demos/kcna26-fleet-gitops/issues/4|Ledger Issue #4>, the finding",
			typ:   model.EventChat,
			title: "The first critical finding from the Workload Reliability Audit report is that the ledger-db database's…",
		},
		{
			name: "person asks", reply: false,
			text:  "@kubeagents what is wrong with recommendationservice? It's on boutique-prod.",
			typ:   model.EventChat,
			title: "@kubeagents what is wrong with recommendationservice?",
		},
		{
			name: "person writes a checkmark", reply: true,
			text:  "looks good ✓ thanks",
			typ:   model.EventChat,
			title: "looks good ✓ thanks",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := classify(slackMessage{Text: c.text}, c.reply, c.bot)
			if len(got) != 1 {
				t.Fatalf("got %d signals, want 1: %+v", len(got), got)
			}
			s := got[0]
			if s.Type != c.typ || s.Title != c.title {
				t.Errorf("got %s %q, want %s %q", s.Type, s.Title, c.typ, c.title)
			}
			if len([]rune(s.Title)) > maxTitle {
				t.Errorf("title is %d runes", len([]rune(s.Title)))
			}
			if c.cluster != "" && s.Cluster != c.cluster {
				t.Errorf("cluster %q, want %q", s.Cluster, c.cluster)
			}
			if c.wl != "" && s.Name != c.wl {
				t.Errorf("name %q, want %q", s.Name, c.wl)
			}
			if s.Link != c.link {
				t.Errorf("link %q, want %q", s.Link, c.link)
			}
		})
	}
}

// loadReplies reads the real recommendationservice thread.
func loadReplies(t *testing.T) []slackMessage {
	t.Helper()
	b, err := os.ReadFile("testdata/incident_replies.json")
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Messages []slackMessage `json:"messages"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out.Messages
}

func findTS(t *testing.T, msgs []slackMessage, ts string) slackMessage {
	t.Helper()
	for _, m := range msgs {
		if m.TS == ts {
			return m
		}
	}
	t.Fatalf("no message %s", ts)
	return slackMessage{}
}

// reportTS is the report in the real thread, edited after Gari pressed
// Option B (its buttons became a "✓ Gari Singh (google): …" context line).
const reportTS = "1793642657.279819"

func TestClassifyReportAfterChoice(t *testing.T) {
	m := findTS(t, loadReplies(t), reportTS)
	got := classify(m, true, true)
	if len(got) != 2 {
		t.Fatalf("got %d signals, want report + fix: %+v", len(got), got)
	}
	r, f := got[0], got[1]
	if r.Type != model.EventTriageReport {
		t.Fatalf("first is %s", r.Type)
	}
	if !strings.HasPrefix(r.Title, "The recommendationservice pod online-boutique/recommendationservice-659fd87c86-c7xjn is failing") {
		t.Errorf("report title %q", r.Title)
	}
	want := "Option A: Revert to working 32Mi\nOption B: Increase to 64Mi with headroom\nRecommended: Option B (Increase to 64Mi with headroom)"
	if r.Message != want {
		t.Errorf("report message\n%q\nwant\n%q", r.Message, want)
	}
	if f.Type != model.EventFixChosen || f.Actor != "Gari Singh" || f.Title != "Option B: Increase to 64Mi with headroom" ||
		f.TS != "1793643325.000000" || !f.FromEdit {
		t.Errorf("fix %+v", f)
	}
}

func TestClassifyReportBeforeChoice(t *testing.T) {
	m := findTS(t, loadReplies(t), reportTS)
	// As posted: the choice buttons, Option B primary, and no context line.
	m.Edited = nil
	m.Blocks = []slackBlock{{Type: blockActions, Elements: []slackElement{
		{Type: elemButton, ActionID: "kage.choice.0", Text: "Revert to working 32Mi — apply Option A"},
		{Type: elemButton, ActionID: "kage.choice.1", Text: "Increase to 64Mi with headroom — apply Option B", Style: stylePrimary},
		{Type: elemButton, ActionID: "kage.link.0", Text: "GKE Workloads :arrow_upper_right:", URL: "https://console.cloud.google.com/"},
	}}}
	m.Text = strings.Replace(m.Text, ":white_check_mark: *Recommended: Option B*", "", 1)
	got := classify(m, true, true)
	if len(got) != 1 || got[0].Type != model.EventTriageReport {
		t.Fatalf("got %+v", got)
	}
	want := "Option A: Revert to working 32Mi\nOption B: Increase to 64Mi with headroom\nRecommended: Option B (Increase to 64Mi with headroom)"
	if got[0].Message != want {
		t.Errorf("message %q", got[0].Message)
	}
	wantOpts := []model.Option{
		{Letter: "A", Label: "Revert to working 32Mi"},
		{Letter: "B", Label: "Increase to 64Mi with headroom", Recommended: true},
	}
	if !reflect.DeepEqual(got[0].Options, wantOpts) {
		t.Errorf("options %+v", got[0].Options)
	}
}

func TestPlainAndClip(t *testing.T) {
	cases := map[string]string{
		"*Security &amp; RBAC Posture Audit*":                   "Security & RBAC Posture Audit",
		"see <https://x.test/a|the doc> and <https://x.test/b>": "see the doc and https://x.test/b",
		"at 2026-11-02T17:30:41Z :white_check_mark: done":       "at 2026-11-02T17:30:41Z done",
		"_Digging down to the root cause..._":                   "Digging down to the root cause...",
		"<!here> look in <#C123|ops>":                           "@here look in #ops",
	}
	for in, want := range cases {
		if got := plain(in); got != want {
			t.Errorf("plain(%q) = %q, want %q", in, got, want)
		}
	}
	if got := clip("abcdef", 4); got != "abc…" {
		t.Errorf("clip = %q", got)
	}
}
