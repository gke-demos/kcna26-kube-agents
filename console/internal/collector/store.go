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
	"sort"
	"sync"
	"time"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/model"
)

// DefaultSubscriberBuffer is how many event batches a subscriber may fall
// behind before it is dropped and has to resync from a snapshot.
const DefaultSubscriberBuffer = 256

// RecentSignals is how many signal events a snapshot carries.
const RecentSignals = 200

// Store holds the current picture and the subscribers watching it.
type Store struct {
	cluster  string
	source   string
	features model.Features
	now      func() time.Time
	buffer   int

	mu        sync.Mutex
	seq       uint64
	recent    []model.Event
	world     *model.World
	atespaces []model.Atespace
	known     bool // atespaces has been set at least once
	actors    map[string][]model.Agent
	tasks     map[string]map[string]model.Task
	workers   []model.Worker
	pollers   map[string]model.SourceStatus
	subs      map[*Subscription]struct{}
}

// Options configures a Store.
type Options struct {
	Cluster  string
	Source   string
	Features model.Features
	// Now defaults to time.Now.
	Now func() time.Time
	// SubscriberBuffer defaults to DefaultSubscriberBuffer.
	SubscriberBuffer int
}

// NewStore returns an empty store.
func NewStore(o Options) *Store {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.SubscriberBuffer <= 0 {
		o.SubscriberBuffer = DefaultSubscriberBuffer
	}
	return &Store{
		cluster:  o.Cluster,
		source:   o.Source,
		features: o.Features,
		now:      o.Now,
		buffer:   o.SubscriberBuffer,
		world:    model.NewWorld(),
		actors:   map[string][]model.Agent{},
		tasks:    map[string]map[string]model.Task{},
		pollers:  map[string]model.SourceStatus{},
		subs:     map[*Subscription]struct{}{},
	}
}

// Subscription is a stream of event batches. C is closed when the
// subscription is canceled or falls too far behind; Lagged then tells which.
type Subscription struct {
	C      <-chan []model.Event
	c      chan []model.Event
	lagged bool
	store  *Store
}

// Lagged reports whether the subscription was dropped for falling behind.
func (s *Subscription) Lagged() bool {
	s.store.mu.Lock()
	defer s.store.mu.Unlock()
	return s.lagged
}

// Cancel stops the subscription.
func (s *Subscription) Cancel() {
	s.store.mu.Lock()
	defer s.store.mu.Unlock()
	if _, ok := s.store.subs[s]; ok {
		delete(s.store.subs, s)
		close(s.c)
	}
}

// Subscribe returns the current snapshot and a subscription to every event
// after it, atomically.
func (s *Store) Subscribe() (model.Snapshot, *Subscription) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := make(chan []model.Event, s.buffer)
	sub := &Subscription{C: c, c: c, store: s}
	s.subs[sub] = struct{}{}
	return s.snapshotLocked(), sub
}

// Snapshot returns the current picture.
func (s *Store) Snapshot() model.Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.snapshotLocked()
}

// Agent returns one agent.
func (s *Store) Agent(atespace, name string) (model.Agent, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.world.Agents[model.Key(atespace, name)]
	if !ok {
		return model.Agent{}, false
	}
	return *a, true
}

// Seq returns the sequence number of the last event.
func (s *Store) Seq() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.seq
}

func (s *Store) snapshotLocked() model.Snapshot {
	pollers := make([]model.SourceStatus, 0, len(s.pollers))
	for _, p := range s.pollers {
		pollers = append(pollers, p)
	}
	sort.Slice(pollers, func(i, j int) bool { return pollers[i].Name < pollers[j].Name })
	return model.Snapshot{
		Cluster:   s.cluster,
		Source:    s.source,
		Seq:       s.seq,
		Time:      s.now(),
		Atespaces: s.world.SortedAtespaces(),
		Agents:    s.world.SortedAgents(),
		Workers:   s.world.SortedWorkers(),
		Sources:   pollers,
		Features:  s.features,
		Recent:    append([]model.Event{}, s.recent...),
	}
}

// Emit publishes events that don't come from a diff of the picture (signals
// from Slack and GitHub, console actions), stamped with sequence numbers.
// Signal events are also kept for the snapshot's Recent list.
func (s *Store) Emit(evs ...model.Event) []model.Event {
	if len(evs) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	out := make([]model.Event, len(evs))
	for i, ev := range evs {
		s.seq++
		ev.Seq = s.seq
		if ev.Time.IsZero() {
			ev.Time = now
		}
		out[i] = ev
		if model.IsSignal(ev.Type) {
			s.recent = append(s.recent, ev)
		}
	}
	// By event time, not arrival: each source loads its history on start,
	// and the newest signals must survive the cap whichever loaded first.
	sort.SliceStable(s.recent, func(i, j int) bool { return s.recent[i].Time.Before(s.recent[j].Time) })
	if over := len(s.recent) - RecentSignals; over > 0 {
		s.recent = append([]model.Event{}, s.recent[over:]...)
	}
	s.publishLocked(out)
	return out
}

// publishLocked sends a batch to every subscriber, dropping the ones that
// have fallen too far behind.
func (s *Store) publishLocked(evs []model.Event) {
	for sub := range s.subs {
		select {
		case sub.c <- evs:
		default:
			sub.lagged = true
			delete(s.subs, sub)
			close(sub.c)
		}
	}
}

// Apply implements Sink.
func (s *Store) Apply(u Update) { s.Update(u) }

// Update merges an update, diffs the result against the current picture and
// publishes the events. It returns them, stamped with sequence numbers.
func (s *Store) Update(u Update) []model.Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if u.Poller != "" {
		st := model.SourceStatus{Name: u.Poller, OK: u.Err == nil, LastPoll: now}
		if u.Err != nil {
			st.Error = u.Err.Error()
		}
		s.pollers[u.Poller] = st
	}
	if u.Err != nil {
		return nil
	}
	if u.Atespaces != nil {
		s.atespaces = append([]model.Atespace(nil), u.Atespaces...)
		s.known = true
	}
	for as, list := range u.Actors {
		s.actors[as] = list
	}
	for as, tasks := range u.Tasks {
		s.tasks[as] = tasks
	}
	if u.Workers != nil {
		s.workers = append([]model.Worker(nil), u.Workers...)
	}

	next := s.buildLocked(now)
	evs := model.Diff(s.world, next)
	s.world = next
	for i := range evs {
		s.seq++
		evs[i].Seq = s.seq
		evs[i].Time = now
	}
	if len(evs) > 0 {
		s.publishLocked(evs)
	}
	return evs
}

// buildLocked assembles the next world from the latest input of every poller.
func (s *Store) buildLocked(now time.Time) *model.World {
	w := model.NewWorld()
	live := map[string]bool{}
	if s.known {
		for _, a := range s.atespaces {
			w.Atespaces[a.Name] = a
			live[a.Name] = true
		}
		// Forget input for atespaces that are gone.
		for as := range s.actors {
			if !live[as] {
				delete(s.actors, as)
			}
		}
		for as := range s.tasks {
			if !live[as] {
				delete(s.tasks, as)
			}
		}
	}
	for as, list := range s.actors {
		if !s.known {
			// Actors listed before the atespace list arrived still
			// get a district.
			w.Atespaces[as] = model.Atespace{Name: as}
		}
		tasks := s.tasks[as]
		for i := range list {
			a := list[i]
			key := a.Key()
			a.Task = nil
			if t, ok := tasks[a.Name]; ok {
				t := t
				a.Task = &t
			}
			a.StateSince = s.stateSince(key, &a, now)
			w.Agents[key] = &a
		}
	}
	for i := range s.workers {
		wk := s.workers[i]
		w.Workers[wk.Name] = &wk
	}
	return w
}

// stateSince carries the time an agent entered its state across polls.
func (s *Store) stateSince(key string, a *model.Agent, now time.Time) time.Time {
	if old, ok := s.world.Agents[key]; ok {
		if old.State == a.State {
			return old.StateSince
		}
		return now
	}
	// First sight: the actor's last update is the best guess at when it
	// entered its state (on collector startup this gives sensible "suspended
	// for 2h" ages).
	if a.UpdateTime != nil && !a.UpdateTime.IsZero() && a.UpdateTime.Before(now) {
		return *a.UpdateTime
	}
	return now
}
