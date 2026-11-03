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
// repo into signal events (see model.IsSignal). STUB: interface fixed, body
// to come.
package signals

import (
	"context"
	"time"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/model"
)

// Emitter publishes signal events (collector.Store implements it).
type Emitter interface {
	Emit(evs ...model.Event) []model.Event
}

// Resolver maps a cluster and workload name to the workload's key, and
// whether that workload is currently drawn.
type Resolver func(cluster, name string) (key string, ok bool)

// SlackOptions configures the Slack poller.
type SlackOptions struct {
	Token   string
	Channel string
	// Interval between polls (default 5s).
	Interval time.Duration
}

// Slack polls the channel and its threads.
type Slack struct{ o SlackOptions }

// NewSlack returns a poller.
func NewSlack(o SlackOptions) *Slack { return &Slack{o: o} }

// Run polls until ctx ends.
func (s *Slack) Run(ctx context.Context, e Emitter, r Resolver) error {
	<-ctx.Done()
	return ctx.Err()
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

// GitHub polls the fleet repo's PRs and audit issues.
type GitHub struct{ o GitHubOptions }

// NewGitHub returns a poller.
func NewGitHub(o GitHubOptions) *GitHub { return &GitHub{o: o} }

// Run polls until ctx ends.
func (g *GitHub) Run(ctx context.Context, e Emitter, r Resolver) error {
	<-ctx.Done()
	return ctx.Err()
}
