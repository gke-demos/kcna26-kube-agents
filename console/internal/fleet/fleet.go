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

// Package fleet is the collector source for the demo fleet: every GKE cluster
// in a project as a district, every workload as an "agent", and kube-agents'
// own agents as the worker deck. STUB: interface fixed, body to come.
package fleet

import (
	"context"
	"time"

	"golang.org/x/oauth2"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/collector"
)

// Options configures the source.
type Options struct {
	// Project whose clusters are drawn.
	Project string
	// Hub is the cluster kube-agents runs on; AgentNamespace its namespace
	// there. On the hub only AgentNamespace's workloads are drawn.
	Hub            string
	AgentNamespace string
	// Interval between workload polls (default 3s); ClusterRefresh between
	// cluster list refreshes (default 60s).
	Interval       time.Duration
	ClusterRefresh time.Duration
	// Exclude are namespaces never drawn (defaults: system namespaces).
	Exclude []string
	// TokenSource authenticates to GKE and the clusters; nil uses ADC.
	TokenSource oauth2.TokenSource
}

// Source polls the fleet.
type Source struct{ o Options }

// New returns a source.
func New(o Options) *Source { return &Source{o: o} }

// Name implements collector.Source.
func (s *Source) Name() string { return "fleet" }

// Run implements collector.Source.
func (s *Source) Run(ctx context.Context, sink collector.Sink) error {
	<-ctx.Done()
	return ctx.Err()
}
