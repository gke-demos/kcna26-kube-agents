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

package collector

import (
	"errors"
	"testing"
	"time"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/model"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func newTestStore(buffer int) (*Store, *clock) {
	c := &clock{t: time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)}
	return NewStore(Options{Cluster: "test", Source: "test", Now: c.now, SubscriberBuffer: buffer}), c
}

func actors(as string, kv ...string) map[string][]model.Agent {
	var list []model.Agent
	for i := 0; i < len(kv); i += 2 {
		list = append(list, model.Agent{Atespace: as, Name: kv[i], State: kv[i+1]})
	}
	return map[string][]model.Agent{as: list}
}

func TestStoreSequencesEvents(t *testing.T) {
	s, _ := newTestStore(0)
	evs := s.Update(Update{Atespaces: []model.Atespace{{Name: "a"}}, Actors: actors("a", "x", model.StateRunning, "y", model.StateSuspended)})
	if len(evs) != 3 { // atespace + 2 agents
		t.Fatalf("got %d events", len(evs))
	}
	for i, e := range evs {
		if e.Seq != uint64(i+1) {
			t.Fatalf("event %d has seq %d", i, e.Seq)
		}
	}
	evs = s.Update(Update{Actors: actors("a", "x", model.StateSuspending, "y", model.StateSuspended)})
	if len(evs) != 2 || evs[0].Seq != 4 || evs[1].Seq != 5 || evs[1].Type != model.EventAgentSuspended {
		t.Fatalf("second update events = %+v", evs)
	}
	if s.Snapshot().Seq != 5 {
		t.Fatalf("snapshot seq = %d", s.Snapshot().Seq)
	}
}

func TestStoreStateSince(t *testing.T) {
	s, c := newTestStore(0)
	s.Update(Update{Actors: actors("a", "x", model.StateRunning)})
	start := c.t
	c.t = c.t.Add(time.Minute)
	s.Update(Update{Actors: actors("a", "x", model.StateRunning)})
	if a, _ := s.Agent("a", "x"); !a.StateSince.Equal(start) {
		t.Fatalf("StateSince moved without a state change: %v", a.StateSince)
	}
	c.t = c.t.Add(time.Minute)
	s.Update(Update{Actors: actors("a", "x", model.StateSuspended)})
	if a, _ := s.Agent("a", "x"); !a.StateSince.Equal(c.t) {
		t.Fatalf("StateSince = %v, want %v", a.StateSince, c.t)
	}
}

func TestStoreJoinsTasksAndDropsGoneAtespaces(t *testing.T) {
	s, _ := newTestStore(0)
	s.Update(Update{Atespaces: []model.Atespace{{Name: "a"}, {Name: "b"}}, Actors: actors("a", "x", model.StateRunning)})
	s.Update(Update{Actors: actors("b", "z", model.StateRunning)})
	evs := s.Update(Update{Tasks: map[string]map[string]model.Task{"a": {"x": {Phase: "Running"}}}})
	if len(evs) != 1 || evs[0].Type != model.EventTaskUpdated || !evs[0].New {
		t.Fatalf("task join events = %+v", evs)
	}
	if a, _ := s.Agent("a", "x"); a.Task == nil || a.Task.Phase != "Running" {
		t.Fatalf("agent has no task: %+v", a)
	}
	evs = s.Update(Update{Atespaces: []model.Atespace{{Name: "a"}}})
	want := map[string]bool{model.EventAgentRemoved: true, model.EventAtespaceRemoved: true}
	if len(evs) != 2 || !want[evs[0].Type] || !want[evs[1].Type] {
		t.Fatalf("atespace removal events = %+v", evs)
	}
	if _, ok := s.Agent("b", "z"); ok {
		t.Fatal("agent in removed atespace is still there")
	}
}

func TestStoreFailedPollKeepsState(t *testing.T) {
	s, _ := newTestStore(0)
	s.Update(Update{Poller: "p", Actors: actors("a", "x", model.StateRunning)})
	if evs := s.Update(Update{Poller: "p", Err: errors.New("boom")}); len(evs) != 0 {
		t.Fatalf("failed poll produced events: %+v", evs)
	}
	snap := s.Snapshot()
	if len(snap.Agents) != 1 || len(snap.Sources) != 1 || snap.Sources[0].OK || snap.Sources[0].Error != "boom" {
		t.Fatalf("snapshot after failed poll = %+v", snap)
	}
}

func TestStoreSubscribe(t *testing.T) {
	s, _ := newTestStore(4)
	s.Update(Update{Actors: actors("a", "x", model.StateRunning)})
	snap, sub := s.Subscribe()
	defer sub.Cancel()
	if snap.Seq != 2 || len(snap.Agents) != 1 {
		t.Fatalf("snapshot = %+v", snap)
	}
	s.Update(Update{Actors: actors("a", "x", model.StateSuspending)})
	evs := <-sub.C
	if evs[0].Seq != snap.Seq+1 {
		t.Fatalf("first event seq %d does not follow snapshot seq %d", evs[0].Seq, snap.Seq)
	}
}

func TestStoreDropsLaggingSubscriber(t *testing.T) {
	s, _ := newTestStore(2)
	_, sub := s.Subscribe()
	states := []string{model.StateRunning, model.StateSuspending, model.StateSuspended, model.StateResuming}
	for _, st := range states {
		s.Update(Update{Actors: actors("a", "x", st)})
	}
	n := 0
	for range sub.C {
		n++
	}
	if n != 2 || !sub.Lagged() {
		t.Fatalf("received %d batches, lagged=%v; want 2 and lagged", n, sub.Lagged())
	}
	sub.Cancel() // safe after the store dropped it
}

func TestLocate(t *testing.T) {
	s := NewStore(Options{})
	s.Update(Update{
		Atespaces: []model.Atespace{{Name: "boutique-prod"}, {Name: "bank-prod"}},
		Actors: map[string][]model.Agent{
			"boutique-prod": {{Atespace: "boutique-prod", Name: "frontend", Namespace: "online-boutique"}},
			"bank-prod": {
				{Atespace: "bank-prod", Name: "frontend", Namespace: "bank-of-anthos"},
				{Atespace: "bank-prod", Name: "shared", Namespace: "x"},
			},
		},
	})
	if c, ok := s.Locate("online-boutique", "frontend"); !ok || c != "boutique-prod" {
		t.Errorf("online-boutique/frontend: %q %v", c, ok)
	}
	if _, ok := s.Locate("nowhere", "frontend"); ok {
		t.Error("unknown namespace located")
	}
	s.Update(Update{Actors: map[string][]model.Agent{
		"boutique-prod": {{Atespace: "boutique-prod", Name: "shared", Namespace: "x"}},
	}})
	if _, ok := s.Locate("x", "shared"); ok {
		t.Error("ambiguous workload located")
	}
}
