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
	"log/slog"
	"time"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/model"
)

const (
	// AutoResetActor is the auto-reset's Pressed-by trailer and feed actor.
	AutoResetActor = "auto-reset"
	// autoResetCheck is how often the auto-reset looks at the repo.
	autoResetCheck  = time.Minute
	autoResetTitle  = "Auto-reset after %s idle: %s"
	minuteSuffix    = " min"
	autoResetFailed = "failed"
)

// Emitter publishes an event to the console's stream (collector.Store).
type Emitter interface {
	Emit(evs ...model.Event) []model.Event
}

// AutoReset resets the demo once clusters/ has been off the baseline with no
// commit for idle: someone pressed a button and walked away. Any press, merge
// or reset is a commit, so it restarts the clock. It runs the same reset as
// the button and reports it on the stream as an action by AutoResetActor.
// Returns when ctx ends.
func (r *Runner) AutoReset(ctx context.Context, e Emitter, idle time.Duration) {
	t := time.NewTicker(autoResetCheck)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		r.autoResetOnce(ctx, e, idle, time.Now())
	}
}

// autoResetOnce makes one decision; it reports whether it reset.
func (r *Runner) autoResetOnce(ctx context.Context, e Emitter, idle time.Duration, now time.Time) bool {
	off, headAt, err := r.Drift(ctx)
	if err != nil {
		slog.Warn("auto-reset: cannot read the fleet repo", "err", err)
		return false
	}
	if !off || headAt.IsZero() || now.Sub(headAt) < idle {
		return false
	}
	res, err := r.Run(ctx, ActionReset, "", AutoResetActor)
	ev := model.Event{
		Type: model.EventAction, Actor: AutoResetActor, Reason: ActionReset,
		Title: fmt.Sprintf(autoResetTitle, humanIdle(idle), res.Title), Link: res.Link, Commit: res.Commit,
	}
	if err != nil {
		slog.Warn("auto-reset failed", "err", err)
		ev.Title = fmt.Sprintf(autoResetTitle, humanIdle(idle), err.Error())
		ev.Message = autoResetFailed
	} else {
		slog.Info("auto-reset", "idle", idle.String(), "result", res.Title)
	}
	e.Emit(ev)
	return err == nil
}

// humanIdle prints whole minutes as "30 min", anything else as Go does.
func humanIdle(d time.Duration) string {
	if d%time.Minute == 0 {
		return fmt.Sprint(int(d/time.Minute)) + minuteSuffix
	}
	return d.String()
}
