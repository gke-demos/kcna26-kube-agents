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
	"reflect"
	"slices"
	"sort"
	"time"
)

// World is the picture at one point in time, keyed for diffing.
type World struct {
	Atespaces map[string]Atespace
	Agents    map[string]*Agent
	Workers   map[string]*Worker
}

// NewWorld returns an empty world.
func NewWorld() *World {
	return &World{
		Atespaces: map[string]Atespace{},
		Agents:    map[string]*Agent{},
		Workers:   map[string]*Worker{},
	}
}

// IsSuspended reports whether a state means the actor holds no worker and
// stays put until something resumes it.
func IsSuspended(state string) bool {
	return state == StateSuspended || state == StateSuspending || state == StatePaused || state == StatePausing
}

// IsAwake reports whether a state means the actor is running or on its way.
func IsAwake(state string) bool {
	return state == StateRunning || state == StateResuming
}

// suspendReasons are the ax Ready reasons that explain a suspension.
var suspendReasons = map[string]bool{
	ReasonIdleSuspended:      true,
	ReasonCompletedSuspended: true,
	ReasonActorSuspended:     true,
}

// readyReasonSince returns the task's Ready reason if it changed at or after
// since (a condition with no transition time counts as current). Older
// reasons describe an earlier suspend or wake and are ignored.
func readyReasonSince(t *Task, since time.Time) string {
	c := t.Ready()
	if c == nil {
		return ""
	}
	if c.LastTransitionTime != nil && !since.IsZero() && c.LastTransitionTime.Before(since.Add(-2*time.Second)) {
		return ""
	}
	return c.Reason
}

// Diff turns the difference between two worlds into events, ordered so that
// atespaces come before the agents in them and adds before updates. Seq and
// Time are left for the caller to stamp.
func Diff(prev, next *World) []Event {
	var evs []Event

	for _, name := range sortedKeys(next.Atespaces) {
		if _, ok := prev.Atespaces[name]; !ok {
			a := next.Atespaces[name]
			evs = append(evs, Event{Type: EventAtespaceAdded, Key: name, Atespace: &a})
		}
	}

	for _, name := range sortedKeys(next.Workers) {
		w := next.Workers[name]
		old, ok := prev.Workers[name]
		switch {
		case !ok:
			evs = append(evs, Event{Type: EventWorkerAdded, Key: name, Worker: w})
		case !reflect.DeepEqual(old, w):
			evs = append(evs, Event{Type: EventWorkerUpdated, Key: name, Worker: w})
		}
	}

	for _, key := range sortedKeys(next.Agents) {
		a := next.Agents[key]
		old, ok := prev.Agents[key]
		if !ok {
			evs = append(evs, Event{Type: EventAgentAdded, Key: key, Agent: a})
			continue
		}
		evs = append(evs, diffAgent(key, old, a)...)
	}

	for _, key := range sortedKeys(prev.Agents) {
		if _, ok := next.Agents[key]; !ok {
			evs = append(evs, Event{Type: EventAgentRemoved, Key: key, Agent: prev.Agents[key]})
		}
	}
	for _, name := range sortedKeys(prev.Workers) {
		if _, ok := next.Workers[name]; !ok {
			evs = append(evs, Event{Type: EventWorkerRemoved, Key: name, Worker: prev.Workers[name]})
		}
	}
	for _, name := range sortedKeys(prev.Atespaces) {
		if _, ok := next.Atespaces[name]; !ok {
			a := prev.Atespaces[name]
			evs = append(evs, Event{Type: EventAtespaceRemoved, Key: name, Atespace: &a})
		}
	}
	return evs
}

func diffAgent(key string, old, a *Agent) []Event {
	var evs []Event
	if old.State != a.State {
		evs = append(evs, Event{Type: EventAgentState, Key: key, Agent: a, From: old.State, To: a.State})
		switch {
		case a.State == StateCrashed:
			ev := Event{Type: EventAgentCrashed, Key: key, Agent: a, From: old.State}
			if a.Crash != nil {
				ev.Message = a.Crash.Message
			}
			evs = append(evs, ev)
		case IsSuspended(a.State) && !IsSuspended(old.State):
			ev := Event{Type: EventAgentSuspended, Key: key, Agent: a, From: old.State}
			if r := readyReasonSince(a.Task, old.StateSince); suspendReasons[r] {
				ev.Reason = r
			}
			evs = append(evs, ev)
		case IsAwake(a.State) && IsSuspended(old.State):
			// Nothing in Substrate says who resumed the actor. ax (fork)
			// records ResumedByRequest when the router did; it may only
			// show up on a later task poll, as a task_updated with that
			// reason.
			ev := Event{Type: EventAgentWoke, Key: key, Agent: a, From: old.State}
			if r := readyReasonSince(a.Task, old.StateSince); r == ReasonResumedByRequest {
				ev.Reason = r
			}
			evs = append(evs, ev)
		}
	}
	if old.Worker != a.Worker {
		evs = append(evs, Event{Type: EventWorkerAssignment, Key: key, Agent: a, From: old.Worker, To: a.Worker})
	}
	if !reflect.DeepEqual(old.Task, a.Task) {
		ev := Event{Type: EventTaskUpdated, Key: key, Agent: a, New: old.Task == nil && a.Task != nil}
		if oldR, newR := old.Task.Ready(), a.Task.Ready(); newR != nil && (oldR == nil || oldR.Reason != newR.Reason) {
			ev.Reason = newR.Reason
		}
		evs = append(evs, ev)
	}
	if len(evs) == 0 && !sameAgentData(old, a) {
		evs = append(evs, Event{Type: EventAgentUpdated, Key: key, Agent: a})
	}
	return evs
}

// sameAgentData compares everything except the collector's own bookkeeping.
func sameAgentData(a, b *Agent) bool {
	x, y := *a, *b
	x.StateSince, y.StateSince = time.Time{}, time.Time{}
	return reflect.DeepEqual(x, y)
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// SortedAgents returns the world's agents ordered by key.
func (w *World) SortedAgents() []Agent {
	out := make([]Agent, 0, len(w.Agents))
	for _, k := range sortedKeys(w.Agents) {
		out = append(out, *w.Agents[k])
	}
	return out
}

// SortedWorkers returns the world's workers ordered by name.
func (w *World) SortedWorkers() []Worker {
	out := make([]Worker, 0, len(w.Workers))
	for _, k := range sortedKeys(w.Workers) {
		out = append(out, *w.Workers[k])
	}
	return out
}

// SortedAtespaces returns the world's atespaces ordered by name.
func (w *World) SortedAtespaces() []Atespace {
	out := make([]Atespace, 0, len(w.Atespaces))
	for _, k := range sortedKeys(w.Atespaces) {
		out = append(out, w.Atespaces[k])
	}
	return slices.Clip(out)
}
