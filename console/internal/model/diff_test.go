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
	"testing"
	"time"
)

var t0 = time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)

func world(agents ...*Agent) *World {
	w := NewWorld()
	for _, a := range agents {
		w.Atespaces[a.Atespace] = Atespace{Name: a.Atespace}
		w.Agents[a.Key()] = a
	}
	return w
}

func agent(name, state string) *Agent {
	return &Agent{Atespace: "cred-test", Name: name, State: state, StateSince: t0}
}

func withTask(a *Agent, reason string, at time.Time) *Agent {
	a.Task = &Task{Phase: "Running", Conditions: []Condition{{Type: "Ready", Status: "True", Reason: reason, LastTransitionTime: &at}}}
	return a
}

func types(evs []Event) []string {
	out := []string{}
	for _, e := range evs {
		out = append(out, e.Type)
	}
	return out
}

func find(evs []Event, typ string) *Event {
	for i := range evs {
		if evs[i].Type == typ {
			return &evs[i]
		}
	}
	return nil
}

func TestDiffAddRemove(t *testing.T) {
	prev := world(agent("old", StateSuspended))
	next := world(agent("new", StateRunning))
	next.Atespaces["fresh"] = Atespace{Name: "fresh"}
	evs := Diff(prev, next)
	want := []string{EventAtespaceAdded, EventAgentAdded, EventAgentRemoved}
	if got := types(evs); !reflect.DeepEqual(got, want) {
		t.Fatalf("events = %v, want %v", got, want)
	}
	if evs[1].Key != "cred-test/new" || evs[2].Key != "cred-test/old" || evs[2].Agent.State != StateSuspended {
		t.Fatalf("unexpected events %+v", evs)
	}
}

func TestDiffNoChangeNoEvents(t *testing.T) {
	a := agent("a", StateRunning)
	b := *a
	b.StateSince = t0.Add(time.Hour) // bookkeeping only
	if evs := Diff(world(a), world(&b)); len(evs) != 0 {
		t.Fatalf("expected no events, got %v", types(evs))
	}
}

func TestDiffStateTransitions(t *testing.T) {
	cases := []struct {
		name     string
		from, to string
		want     []string
	}{
		{"suspend", StateRunning, StateSuspending, []string{EventAgentState, EventAgentSuspended}},
		{"suspending to suspended is no new suspend", StateSuspending, StateSuspended, []string{EventAgentState}},
		{"wake from suspended", StateSuspended, StateResuming, []string{EventAgentState, EventAgentWoke}},
		{"wake straight to running", StateSuspended, StateRunning, []string{EventAgentState, EventAgentWoke}},
		{"resuming to running is not a second wake", StateResuming, StateRunning, []string{EventAgentState}},
		{"crash", StateRunning, StateCrashed, []string{EventAgentState, EventAgentCrashed}},
		{"pause counts as suspend", StateRunning, StatePausing, []string{EventAgentState, EventAgentSuspended}},
		{"revert", StateCrashed, StateReverting, []string{EventAgentState}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			evs := Diff(world(agent("a", c.from)), world(agent("a", c.to)))
			if got := types(evs); !reflect.DeepEqual(got, c.want) {
				t.Fatalf("events = %v, want %v", got, c.want)
			}
			if evs[0].From != c.from || evs[0].To != c.to {
				t.Fatalf("agent_state from/to = %s/%s", evs[0].From, evs[0].To)
			}
		})
	}
}

func TestDiffCrashCarriesMessage(t *testing.T) {
	next := agent("a", StateCrashed)
	next.Crash = &Crash{Message: "OOMKilled"}
	ev := find(Diff(world(agent("a", StateRunning)), world(next)), EventAgentCrashed)
	if ev == nil || ev.Message != "OOMKilled" {
		t.Fatalf("crash event = %+v", ev)
	}
}

func TestDiffWokeByRequest(t *testing.T) {
	// Suspended since t0; ax recorded ResumedByRequest after that.
	prev := agent("a", StateSuspended)
	next := withTask(agent("a", StateRunning), ReasonResumedByRequest, t0.Add(time.Minute))
	prev.Task = next.Task
	ev := find(Diff(world(prev), world(next)), EventAgentWoke)
	if ev == nil || ev.Reason != ReasonResumedByRequest {
		t.Fatalf("woke event = %+v, want reason ResumedByRequest", ev)
	}
}

func TestDiffWokeIgnoresStaleReason(t *testing.T) {
	// The ResumedByRequest on record is from an earlier wake, before the
	// actor was last suspended: this wake's cause is unknown.
	prev := agent("a", StateSuspended)
	next := withTask(agent("a", StateRunning), ReasonResumedByRequest, t0.Add(-time.Hour))
	prev.Task = next.Task
	ev := find(Diff(world(prev), world(next)), EventAgentWoke)
	if ev == nil || ev.Reason != "" {
		t.Fatalf("woke event = %+v, want no reason", ev)
	}
}

func TestDiffSuspendReason(t *testing.T) {
	prev := agent("a", StateRunning)
	next := withTask(agent("a", StateSuspending), ReasonIdleSuspended, t0.Add(10*time.Minute))
	next.Task.Conditions[0].Status = "False"
	prev.Task = next.Task
	ev := find(Diff(world(prev), world(next)), EventAgentSuspended)
	if ev == nil || ev.Reason != ReasonIdleSuspended {
		t.Fatalf("suspended event = %+v, want IdleSuspended", ev)
	}
}

func TestDiffLateReasonArrivesAsTaskUpdate(t *testing.T) {
	// The actor suspended on one poll; ax's reason shows up on a later one.
	prev := withTask(agent("a", StateSuspended), "TaskRunning", t0)
	next := withTask(agent("a", StateSuspended), ReasonIdleSuspended, t0.Add(time.Second))
	evs := Diff(world(prev), world(next))
	if got := types(evs); !reflect.DeepEqual(got, []string{EventTaskUpdated}) {
		t.Fatalf("events = %v", got)
	}
	if evs[0].Reason != ReasonIdleSuspended || evs[0].New {
		t.Fatalf("task_updated = %+v", evs[0])
	}
}

func TestDiffNewTask(t *testing.T) {
	prev := agent("a", StateRunning)
	next := withTask(agent("a", StateRunning), "TaskRunning", t0)
	ev := find(Diff(world(prev), world(next)), EventTaskUpdated)
	if ev == nil || !ev.New {
		t.Fatalf("task_updated = %+v, want New", ev)
	}
}

func TestDiffWorkerAssignment(t *testing.T) {
	prev := agent("a", StateResuming)
	next := agent("a", StateResuming)
	next.Worker = "w1"
	ev := find(Diff(world(prev), world(next)), EventWorkerAssignment)
	if ev == nil || ev.From != "" || ev.To != "w1" {
		t.Fatalf("worker_assignment = %+v", ev)
	}
}

func TestDiffOtherFieldsAgentUpdated(t *testing.T) {
	prev := agent("a", StateSuspended)
	next := agent("a", StateSuspended)
	next.SnapshotURI = "gs://bucket/snap"
	if got := types(Diff(world(prev), world(next))); !reflect.DeepEqual(got, []string{EventAgentUpdated}) {
		t.Fatalf("events = %v", got)
	}
}

func TestDiffWorkers(t *testing.T) {
	prev, next := NewWorld(), NewWorld()
	prev.Workers["gone"] = &Worker{Name: "gone"}
	prev.Workers["w"] = &Worker{Name: "w", AllocatedActors: 0}
	next.Workers["w"] = &Worker{Name: "w", AllocatedActors: 1, Actors: []string{"cred-test/a"}}
	next.Workers["new"] = &Worker{Name: "new"}
	want := []string{EventWorkerAdded, EventWorkerUpdated, EventWorkerRemoved}
	if got := types(Diff(prev, next)); !reflect.DeepEqual(got, want) {
		t.Fatalf("events = %v, want %v", got, want)
	}
}
