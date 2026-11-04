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

package actions

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/model"
)

type emitted struct{ evs []model.Event }

func (e *emitted) Emit(evs ...model.Event) []model.Event {
	e.evs = append(e.evs, evs...)
	return evs
}

func TestAutoReset(t *testing.T) {
	const idle = 30 * time.Minute
	head := time.Date(2026, 11, 4, 0, 27, 0, 0, time.UTC)
	tests := []struct {
		name       string
		atBaseline bool
		noDate     bool
		since      time.Duration
		wantReset  bool
	}{
		{name: "off baseline and idle: resets", since: 9 * time.Hour, wantReset: true},
		{name: "off baseline but recent: waits", since: 10 * time.Minute},
		{name: "just under the idle time: waits", since: idle - time.Second},
		{name: "at baseline: nothing to do", atBaseline: true, since: 9 * time.Hour},
		{name: "no commit date: never guesses", noDate: true, since: 9 * time.Hour},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f, r := newFake(t)
			seedReset(f, tc.atBaseline)
			if !tc.noDate {
				f.commitDate = head
			}
			e := &emitted{}
			got := r.autoResetOnce(context.Background(), e, idle, head.Add(tc.since))
			if got != tc.wantReset {
				t.Fatalf("reset = %v, want %v", got, tc.wantReset)
			}
			if !tc.wantReset {
				if len(e.evs) != 0 || len(f.createdCommit) != 0 {
					t.Fatalf("acted anyway: events %v, commits %v", e.evs, f.createdCommit)
				}
				return
			}
			if len(f.createdCommit) != 1 {
				t.Fatalf("commits created: %d", len(f.createdCommit))
			}
			if msg := f.createdCommit[0]["message"].(string); !strings.Contains(msg, "Pressed-by: "+AutoResetActor) {
				t.Errorf("commit message lacks the auto-reset trailer: %q", msg)
			}
			if len(e.evs) != 1 {
				t.Fatalf("events: %v", e.evs)
			}
			ev := e.evs[0]
			if ev.Type != model.EventAction || ev.Actor != AutoResetActor || ev.Reason != ActionReset ||
				!strings.HasPrefix(ev.Title, "Auto-reset after 30 min idle: reset:") || ev.Message == autoResetFailed {
				t.Errorf("event %+v", ev)
			}
		})
	}
}
