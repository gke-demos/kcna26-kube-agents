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

// Package signals turns what happens in the Slack channel and on the fleet
// repo into signal events (see model.IsSignal): the Slack poller reports
// alerts, triage notes, reports, chosen fixes and chat; the GitHub poller
// reports pull requests and audit ledger issues.
package signals

import (
	"net/http"
	"time"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/model"
)

const (
	// maxTitle and maxMessage bound Event.Title and Event.Message, in runes.
	maxTitle   = 120
	maxMessage = 600
	// maxText bounds Event.Text, the full message for the thread view.
	maxText = 12000
	// httpTimeout bounds one API request.
	httpTimeout = 20 * time.Second
)

// Emitter publishes signal events (collector.Store implements it).
type Emitter interface {
	Emit(evs ...model.Event) []model.Event
}

// Resolver maps a cluster and workload name to the workload's key, and
// whether that workload is currently drawn.
type Resolver func(cluster, name string) (key string, ok bool)

// resolveKey returns the workload's key, or "" when the cluster or name is
// unknown or the workload is not drawn.
func resolveKey(r Resolver, cluster, name string) string {
	if r == nil || cluster == "" || name == "" {
		return ""
	}
	if key, ok := r(cluster, name); ok {
		return key
	}
	return ""
}

// SlackOptions configures the Slack poller.
type SlackOptions struct {
	Token   string
	Channel string
	// Interval between polls (default 5s).
	Interval time.Duration
}

// NewSlack returns a poller.
func NewSlack(o SlackOptions) *Slack {
	if o.Interval <= 0 {
		o.Interval = defaultSlackInterval
	}
	return &Slack{
		o:        o,
		api:      defaultSlackAPI,
		client:   &http.Client{Timeout: httpTimeout},
		lookback: slackLookback,
		window:   slackThreadWindow,
		now:      time.Now,
	}
}

// GitHubOptions configures the GitHub poller.
type GitHubOptions struct {
	Token string
	// Repo is owner/name.
	Repo string
	// AuditBranchPrefix marks the audits' PRs (reported as EventAudit).
	AuditBranchPrefix string
	// Interval between polls (default 15s).
	Interval time.Duration
}

// NewGitHub returns a poller.
func NewGitHub(o GitHubOptions) *GitHub {
	if o.Interval <= 0 {
		o.Interval = defaultGitHubInterval
	}
	return &GitHub{
		o:        o,
		api:      defaultGitHubAPI,
		client:   &http.Client{Timeout: httpTimeout},
		lookback: githubLookback,
		now:      time.Now,
	}
}
