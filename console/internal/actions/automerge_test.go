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
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/model"
)

func TestAutoMerge(t *testing.T) {
	const after = time.Minute
	now := time.Date(2026, 11, 5, 17, 0, 0, 0, time.UTC)
	f, r := newFake(t)
	f.pulls = []pr{
		{number: 17, ref: "platform-agent/incident-boutique-prod-frontend-1", headRepo: repo, created: now.Add(-2 * time.Minute)},
		{number: 18, ref: "platform-agent/incident-bank-prod-userservice-2", headRepo: repo, created: now.Add(-10 * time.Second)},
		{number: 7, ref: "platform-agent/fix-obtainability-audit-ledger-db-pdb", headRepo: repo, created: now.Add(-48 * time.Hour)},
		{number: 3, ref: "someone/else", headRepo: repo, created: now.Add(-48 * time.Hour)},
	}
	e := &emitted{}
	tried := map[int]bool{}

	got := r.autoMergeOnce(context.Background(), e, after, now, tried)
	if fmt.Sprint(got) != "[17]" {
		t.Fatalf("merged %v, want only the incident PR open longer than %s", got, after)
	}
	if msg := f.merged[17]; !strings.Contains(msg, "Pressed-by: "+AutoMergeActor) {
		t.Errorf("merge commit message lacks the trailer: %q", msg)
	}
	if len(e.evs) != 1 || e.evs[0].Type != model.EventAction || e.evs[0].Actor != AutoMergeActor ||
		!strings.HasPrefix(e.evs[0].Title, "Auto-merged PR #17 after 1 min (booth mode):") || e.evs[0].Link == "" {
		t.Fatalf("events %+v", e.evs)
	}

	// The young PR comes due later; #17 is not merged twice.
	got = r.autoMergeOnce(context.Background(), e, after, now.Add(time.Minute), tried)
	if fmt.Sprint(got) != "[18]" {
		t.Fatalf("second pass merged %v, want [18]", got)
	}
	if len(f.merged) != 2 {
		t.Fatalf("merges: %v", f.merged)
	}
}

func TestAutoMergeRefusedOnce(t *testing.T) {
	now := time.Date(2026, 11, 5, 17, 0, 0, 0, time.UTC)
	f, r := newFake(t)
	f.pulls = []pr{{number: 19, ref: "platform-agent/incident-x", headRepo: repo, created: now.Add(-time.Hour)}}
	f.refuseMerge = map[int]bool{19: true}
	e := &emitted{}
	tried := map[int]bool{}
	for i := 0; i < 3; i++ {
		if got := r.autoMergeOnce(context.Background(), e, time.Minute, now, tried); len(got) != 0 {
			t.Fatalf("merged %v", got)
		}
	}
	if len(e.evs) != 1 || e.evs[0].Message != autoResetFailed || !strings.Contains(e.evs[0].Title, "PR #19 failed") {
		t.Fatalf("want one failure event, got %+v", e.evs)
	}
}
