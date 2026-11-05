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
	"net/http"
	"strings"
	"time"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/model"
)

const (
	// AutoMergeActor is the auto-merge's Pressed-by trailer and feed actor.
	AutoMergeActor = "auto-merge"
	// IncidentBranchPrefix marks the PRs the triage opens for an incident
	// (INCIDENT_TRIAGE_OPEN_PULL_REQUEST). Audit PRs are never merged.
	IncidentBranchPrefix = "platform-agent/incident-"
	// autoMergeCheck is how often the auto-merge looks for PRs.
	autoMergeCheck   = 10 * time.Second
	pathPullMerge    = "/repos/%s/pulls/%d/merge"
	mergeMethod      = "merge"
	autoMergeTitle   = "Auto-merged PR #%d after %s (booth mode): %s"
	autoMergeFailFmt = "Auto-merge of PR #%d failed: %s"
	autoMergeBody    = "Merged by the fleet-scope console's booth mode."
)

// AutoMerge merges incident PRs once they have been open for after, so a booth
// incident heals without staff while visitors still see the PR open. Only
// branches with IncidentBranchPrefix qualify. Each merge is reported on the
// stream as an action by AutoMergeActor. Returns when ctx ends.
func (r *Runner) AutoMerge(ctx context.Context, e Emitter, after time.Duration) {
	t := time.NewTicker(autoMergeCheck)
	defer t.Stop()
	tried := map[int]bool{}
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		r.autoMergeOnce(ctx, e, after, time.Now(), tried)
	}
}

// autoMergeOnce merges what is due; it returns the PR numbers it merged.
// tried remembers PRs already attempted, so a PR GitHub refuses to merge is
// reported once, not every few seconds.
func (r *Runner) autoMergeOnce(ctx context.Context, e Emitter, after time.Duration, now time.Time, tried map[int]bool) []int {
	open, err := r.openPRs(ctx)
	if err != nil {
		slog.Warn("auto-merge: cannot list PRs", "err", err)
		return nil
	}
	var merged []int
	for _, pr := range open {
		if !strings.HasPrefix(pr.Head.Ref, IncidentBranchPrefix) || tried[pr.Number] || now.Sub(pr.CreatedAt) < after {
			continue
		}
		tried[pr.Number] = true
		if err := r.merge(ctx, pr); err != nil {
			slog.Warn("auto-merge failed", "pr", pr.Number, "err", err)
			e.Emit(model.Event{Type: model.EventAction, Actor: AutoMergeActor, Reason: AutoMergeActor,
				Title: fmt.Sprintf(autoMergeFailFmt, pr.Number, err), Link: pr.HTMLURL, Message: autoResetFailed})
			continue
		}
		slog.Info("auto-merge", "pr", pr.Number, "after", after.String())
		e.Emit(model.Event{Type: model.EventAction, Actor: AutoMergeActor, Reason: AutoMergeActor,
			Title: fmt.Sprintf(autoMergeTitle, pr.Number, humanDuration(after), pr.Title), Link: pr.HTMLURL})
		merged = append(merged, pr.Number)
	}
	return merged
}

// merge merges one PR, serialized with the buttons (a merge moves the branch
// head a press may be about to edit).
func (r *Runner) merge(ctx context.Context, pr pullRequest) error {
	select {
	case r.sem <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-r.sem }()
	req := map[string]string{
		"merge_method":   mergeMethod,
		"commit_message": autoMergeBody + subjectBodyGlue + fmt.Sprintf(trailerFmt, AutoMergeActor),
	}
	return r.call(ctx, http.MethodPut, fmt.Sprintf(pathPullMerge, r.o.Repo, pr.Number), req, nil)
}
