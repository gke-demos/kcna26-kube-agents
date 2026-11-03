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

package model

import (
	"time"
)

// Event types.
const (
	EventAgentAdded       = "agent_added"
	EventAgentRemoved     = "agent_removed"
	EventAgentState       = "agent_state"
	EventAgentWoke        = "agent_woke"
	EventAgentSuspended   = "agent_suspended"
	EventAgentCrashed     = "agent_crashed"
	EventAgentUpdated     = "agent_updated"
	EventWorkerAssignment = "worker_assignment"
	EventTaskUpdated      = "task_updated"
	EventWorkerAdded      = "worker_added"
	EventWorkerRemoved    = "worker_removed"
	EventWorkerUpdated    = "worker_updated"
	EventAtespaceAdded    = "atespace_added"
	EventAtespaceRemoved  = "atespace_removed"
	// EventClusterSynced: a cluster's Config Sync applied a new fleet-repo
	// commit (Cluster, Commit; Atespace carries the cluster as it is now).
	EventClusterSynced = "cluster_synced"
)

// Signal events: what the agents and people did about the fleet, from Slack
// and GitHub rather than from a diff of the picture. Key names the workload
// ("cluster/name") when the signal is about one; Link is where it happened.
const (
	// EventAlert: the event watcher's alert landed in the Slack channel.
	EventAlert = "alert"
	// EventTriage: a progress note in an alert's thread.
	EventTriage = "triage"
	// EventTriageReport: the Cluster Agent's report with fix options.
	EventTriageReport = "triage_report"
	// EventFixChosen: someone picked an option (a button or "apply").
	EventFixChosen = "fix_chosen"
	// EventPROpened, EventPRMerged, EventPRClosed: a pull request on the
	// fleet repo (not one the overnight audits opened: those are EventAudit).
	EventPROpened = "pr_opened"
	EventPRMerged = "pr_merged"
	EventPRClosed = "pr_closed"
	// EventAudit: an audit's ledger issue or fix PR appeared or changed.
	EventAudit = "audit"
	// EventChat: a message in the channel that is none of the above (a
	// question to the agent, its answer, a drift note).
	EventChat = "chat"
	// EventAction: someone pressed a console button (trigger or reset).
	EventAction = "action"
)

// IsSignal reports whether an event type is a signal (kept in Snapshot.Recent).
func IsSignal(t string) bool {
	switch t {
	case EventAlert, EventTriage, EventTriageReport, EventFixChosen,
		EventPROpened, EventPRMerged, EventPRClosed, EventAudit, EventChat, EventAction:
		return true
	}
	return false
}

// Event is one change to the picture. Agent events carry the agent as it is
// after the change (as it was, for agent_removed), so a client can apply any
// agent event by replacing its copy.
type Event struct {
	Seq      uint64    `json:"seq"`
	Time     time.Time `json:"time"`
	Type     string    `json:"type"`
	Key      string    `json:"key,omitempty"`
	Agent    *Agent    `json:"agent,omitempty"`
	Worker   *Worker   `json:"worker,omitempty"`
	Atespace *Atespace `json:"atespace,omitempty"`
	// From and To are the old and new state (agent_state), or the old and
	// new worker (worker_assignment).
	From string `json:"from,omitempty"`
	To   string `json:"to,omitempty"`
	// Reason explains agent_suspended (IdleSuspended, CompletedSuspended,
	// ActorSuspended) and agent_woke (ResumedByRequest when ax says the
	// router resumed the task).
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
	// New marks a task_updated for a task the agent didn't have before.
	New bool `json:"new,omitempty"`

	// Signal fields. Cluster is set even when Key is not (a PR whose file
	// names no workload, say). Title is one line for the feed; Link is the
	// Slack permalink, PR or issue URL; Actor is who did it ("kube-agents",
	// a GitHub login, a Slack display name); Thread groups the events of one
	// incident (the alert's Slack ts).
	Cluster string `json:"cluster,omitempty"`
	Title   string `json:"title,omitempty"`
	Link    string `json:"link,omitempty"`
	Actor   string `json:"actor,omitempty"`
	Thread  string `json:"thread,omitempty"`

	// Slack signals also carry the message itself, for the console's thread
	// view: Text is its full Slack mrkdwn (mentions expanded, Slack's &amp;
	// &lt; &gt; escapes kept), TS its Slack timestamp, Permalink a link to
	// the message (Link may point elsewhere, at a PR), and Options a report's
	// choice buttons.
	Text      string   `json:"text,omitempty"`
	TS        string   `json:"ts,omitempty"`
	Permalink string   `json:"permalink,omitempty"`
	Options   []Option `json:"options,omitempty"`

	// Commit is a fleet-repo SHA: the one an action pushed, or the one a
	// cluster's Config Sync has applied (EventClusterSynced).
	Commit string `json:"commit,omitempty"`
}

// Option is one of a triage report's fixes.
type Option struct {
	// Letter is "A", "B", ...; Label the button's text.
	Letter      string `json:"letter"`
	Label       string `json:"label"`
	Recommended bool   `json:"recommended,omitempty"`
}
