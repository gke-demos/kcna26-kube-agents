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

// Package collector keeps the current picture of a cluster, turns changes into
// sequenced events and fans them out to subscribers. Data comes from a Source:
// the live Substrate and ax pollers (internal/cluster) or, later, a simulator.
// Both feed the same Store, so the API and the front end can't tell them apart.
package collector

import (
	"context"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/model"
)

// Source produces updates until ctx is done.
type Source interface {
	// Name is "cluster" for the live pollers, "sim" for the simulator.
	Name() string
	// Run pushes updates to sink until ctx is canceled.
	Run(ctx context.Context, sink Sink) error
}

// Sink receives updates from a Source.
type Sink interface {
	Apply(u Update)
}

// Update is a partial refresh of the picture. Nil fields leave that part as it
// was, so pollers running on different schedules can each report their own
// part.
type Update struct {
	// Poller names the poller for health reporting ("substrate/actors").
	Poller string
	// Err reports a failed poll; the rest of the update is ignored.
	Err error

	// Atespaces, when non-nil, replaces the atespace list. Actors and tasks
	// in atespaces that disappear are dropped.
	Atespaces []model.Atespace
	// Actors replaces the actor list of each atespace it names. Agent.Task is
	// ignored; tasks come from Tasks.
	Actors map[string][]model.Agent
	// Tasks replaces the ax tasks of each atespace it names, keyed by the
	// actor name the task runs as.
	Tasks map[string]map[string]model.Task
	// Workers, when non-nil, replaces the worker list (with assignments).
	Workers []model.Worker
}
