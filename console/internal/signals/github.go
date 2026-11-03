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

package signals

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/model"
)

const (
	defaultGitHubInterval = 15 * time.Second
	defaultGitHubAPI      = "https://api.github.com"
	// githubLookback is how far back the state emitted on start reaches.
	githubLookback = 24 * time.Hour
	// githubPageSize is the page size for PRs and issues; filesPageSize for
	// a PR's files.
	githubPageSize = 30
	filesPageSize  = 100
	// auditLabel marks the audits' ledger issues.
	auditLabel = "agent:audit"

	headerAPIVersion  = "X-GitHub-Api-Version"
	githubAPIVersion  = "2022-11-28"
	headerAccept      = "Accept"
	githubAccept      = "application/vnd.github+json"
	headerETag        = "ETag"
	headerIfNoneMatch = "If-None-Match"

	pullsPathFmt  = "%s/repos/%s/pulls?state=all&sort=updated&direction=desc&per_page=%d"
	issuesPathFmt = "%s/repos/%s/issues?state=all&sort=updated&direction=desc&per_page=%d&labels=%s"
	pullPathFmt   = "%s/repos/%s/pulls/%d"
	filesPathFmt  = "%s/repos/%s/pulls/%d/files?per_page=%d"

	stateOpen = "open"
	// Feed titles: "PR #1 merged: <title>".
	titleOpenedFmt   = "PR #%d opened: %s"
	titleReopenedFmt = "PR #%d reopened: %s"
	titleMergedFmt   = "PR #%d merged: %s"
	titleClosedFmt   = "PR #%d closed: %s"
	titleAuditPRFmt  = "Audit PR #%d opened: %s"
	// nameSep separates the segments of a manifest's file stem.
	nameSep = "-"
)

// manifestRe reads clusters/<cluster>/namespaces/<ns>/<file>.yaml.
var manifestRe = regexp.MustCompile(`^clusters/([^/]+)/namespaces/([^/]+)/([^/]+)\.ya?ml$`)

// GitHub polls the fleet repo's PRs and audit issues.
type GitHub struct {
	o GitHubOptions
	// api is the REST base URL; client, lookback and now are overridden in
	// tests.
	api      string
	client   *http.Client
	lookback time.Duration
	now      func() time.Time

	etags   map[string]string
	prs     map[int]prState
	issues  map[int]time.Time
	targets map[int]target
	started bool
}

// prState is what a transition is measured against.
type prState struct {
	state  string
	merged bool
}

// target is the workload a PR changes.
type target struct{ cluster, name string }

type ghUser struct {
	Login string `json:"login"`
}

type ghPull struct {
	Number    int        `json:"number"`
	State     string     `json:"state"`
	Title     string     `json:"title"`
	HTMLURL   string     `json:"html_url"`
	User      ghUser     `json:"user"`
	MergedBy  *ghUser    `json:"merged_by"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	ClosedAt  *time.Time `json:"closed_at"`
	MergedAt  *time.Time `json:"merged_at"`
	Head      struct {
		Ref string `json:"ref"`
	} `json:"head"`
}

type ghIssue struct {
	Number      int             `json:"number"`
	Title       string          `json:"title"`
	HTMLURL     string          `json:"html_url"`
	User        ghUser          `json:"user"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
	PullRequest json.RawMessage `json:"pull_request"`
}

// Run polls until ctx ends.
func (g *GitHub) Run(ctx context.Context, e Emitter, r Resolver) error {
	g.reset()
	t := time.NewTicker(g.o.Interval)
	defer t.Stop()
	for {
		if err := g.poll(ctx, e, r); err != nil && ctx.Err() == nil {
			slog.Warn("github: poll failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (g *GitHub) reset() {
	g.etags = map[string]string{}
	g.prs = map[int]prState{}
	g.issues = map[int]time.Time{}
	g.targets = map[int]target{}
}

// poll reads PRs and audit issues and emits what changed. The first
// successful poll emits the state of everything updated in the lookback.
func (g *GitHub) poll(ctx context.Context, e Emitter, r Resolver) error {
	cut := g.now().Add(-g.lookback)
	var pulls []ghPull
	pullsChanged, err := g.getJSON(ctx, fmt.Sprintf(pullsPathFmt, g.api, g.o.Repo, githubPageSize), true, &pulls)
	if err != nil {
		return err
	}
	var evs []model.Event
	if pullsChanged {
		for _, p := range pulls {
			evs = append(evs, g.pullEvents(ctx, p, cut, r)...)
		}
	}
	// PR events are emitted even when the issue poll fails: the PR list's
	// ETag has moved on, so they would not come round again.
	defer func() { emit(e, evs) }()
	var issues []ghIssue
	issuesChanged, err := g.getJSON(ctx, fmt.Sprintf(issuesPathFmt, g.api, g.o.Repo, githubPageSize, url.QueryEscape(auditLabel)), true, &issues)
	if err != nil {
		return err
	}
	if issuesChanged {
		for _, is := range issues {
			if len(is.PullRequest) > 0 && string(is.PullRequest) != "null" {
				continue // the PR poll covers it
			}
			last, known := g.issues[is.Number]
			g.issues[is.Number] = is.UpdatedAt
			if known && !is.UpdatedAt.After(last) {
				continue
			}
			if !known && !g.started && is.UpdatedAt.Before(cut) {
				continue
			}
			evs = append(evs, model.Event{
				Type:  model.EventAudit,
				Time:  is.UpdatedAt,
				Title: clip(is.Title, maxTitle),
				Link:  is.HTMLURL,
				Actor: is.User.Login,
			})
		}
	}
	g.started = true
	return nil
}

// pullEvents returns a PR's transitions since the last poll; on start, its
// story inside the lookback (opened, then merged or closed).
func (g *GitHub) pullEvents(ctx context.Context, p ghPull, cut time.Time, r Resolver) []model.Event {
	cur := prState{state: p.State, merged: p.MergedAt != nil}
	prev, known := g.prs[p.Number]
	g.prs[p.Number] = cur
	if known && prev == cur {
		return nil
	}
	if !known && !g.started && p.UpdatedAt.Before(cut) {
		return nil
	}
	audit := g.o.AuditBranchPrefix != "" && strings.HasPrefix(p.Head.Ref, g.o.AuditBranchPrefix)
	var evs []model.Event
	add := func(typ, format string, at time.Time, actor string) {
		evs = append(evs, model.Event{
			Type:  typ,
			Time:  at,
			Title: clip(fmt.Sprintf(format, p.Number, p.Title), maxTitle),
			Link:  p.HTMLURL,
			Actor: actor,
		})
	}
	opened := !known && (cur.state == stateOpen || !g.started || p.CreatedAt.After(cut))
	if opened {
		if audit {
			add(model.EventAudit, titleAuditPRFmt, p.CreatedAt, p.User.Login)
		} else {
			add(model.EventPROpened, titleOpenedFmt, p.CreatedAt, p.User.Login)
		}
	}
	if known && prev.state != stateOpen && cur.state == stateOpen {
		add(model.EventPROpened, titleReopenedFmt, p.UpdatedAt, p.User.Login)
	}
	if cur.state != stateOpen && (!known || prev.state == stateOpen) {
		if cur.merged {
			add(model.EventPRMerged, titleMergedFmt, *p.MergedAt, g.mergedBy(ctx, p))
		} else {
			at := p.UpdatedAt
			if p.ClosedAt != nil {
				at = *p.ClosedAt
			}
			add(model.EventPRClosed, titleClosedFmt, at, p.User.Login)
		}
	}
	// Every event of an audit PR is an audit event (model.EventAudit), merges
	// and closes included: the console tells the audits' work from incidents'.
	if audit {
		for i := range evs {
			evs[i].Type = model.EventAudit
		}
	}
	if len(evs) == 0 {
		return nil
	}
	tg := g.target(ctx, p.Number, r)
	for i := range evs {
		evs[i].Cluster = tg.cluster
		evs[i].Key = resolveKey(r, tg.cluster, tg.name)
	}
	return evs
}

// mergedBy reads who merged a PR (the list omits it), else its author.
func (g *GitHub) mergedBy(ctx context.Context, p ghPull) string {
	if p.MergedBy != nil && p.MergedBy.Login != "" {
		return p.MergedBy.Login
	}
	var full ghPull
	if _, err := g.getJSON(ctx, fmt.Sprintf(pullPathFmt, g.api, g.o.Repo, p.Number), false, &full); err != nil {
		slog.Debug("github: reading PR failed", "pr", p.Number, "err", err)
	}
	if full.MergedBy != nil && full.MergedBy.Login != "" {
		return full.MergedBy.Login
	}
	return p.User.Login
}

// target maps a PR to the workload its manifests name, reading its files
// once. A file stem names the workload ("recommendationservice.yaml"), or
// does after dropping trailing segments ("frontend-pdb.yaml" → frontend).
func (g *GitHub) target(ctx context.Context, n int, r Resolver) target {
	if tg, ok := g.targets[n]; ok {
		return tg
	}
	var files []struct {
		Filename string `json:"filename"`
	}
	if _, err := g.getJSON(ctx, fmt.Sprintf(filesPathFmt, g.api, g.o.Repo, n, filesPageSize), false, &files); err != nil {
		slog.Warn("github: listing PR files failed", "pr", n, "err", err)
		return target{}
	}
	var tg target
	for _, f := range files {
		sm := manifestRe.FindStringSubmatch(f.Filename)
		if sm == nil {
			continue
		}
		cand := workloadName(r, sm[1], sm[3])
		if tg.cluster == "" {
			tg = target{cluster: sm[1], name: cand}
		}
		if resolveKey(r, sm[1], cand) != "" {
			tg = target{cluster: sm[1], name: cand}
			break
		}
	}
	g.targets[n] = tg
	return tg
}

// workloadName returns the longest prefix of a file stem (cut at "-") that
// resolves, else the stem.
func workloadName(r Resolver, cluster, stem string) string {
	parts := strings.Split(stem, nameSep)
	for i := len(parts); i > 0; i-- {
		cand := strings.Join(parts[:i], nameSep)
		if resolveKey(r, cluster, cand) != "" {
			return cand
		}
	}
	return stem
}

// getJSON GETs a REST URL into out. With conditional set it sends the last
// ETag and reports false, leaving out untouched, on 304.
func (g *GitHub) getJSON(ctx context.Context, u string, conditional bool, out any) (bool, error) {
	hdr := map[string]string{headerAPIVersion: githubAPIVersion, headerAccept: githubAccept}
	if conditional {
		if tag := g.etags[u]; tag != "" {
			hdr[headerIfNoneMatch] = tag
		}
	}
	resp, err := do(ctx, g.client, u, g.o.Token, hdr)
	if err != nil {
		return false, err
	}
	if resp.status == http.StatusNotModified {
		return false, nil
	}
	if resp.status != http.StatusOK {
		return false, fmt.Errorf("%s: HTTP %d", redactQuery(u), resp.status)
	}
	if err := json.Unmarshal(resp.body, out); err != nil {
		return false, err
	}
	if conditional {
		if tag := resp.header.Get(headerETag); tag != "" {
			g.etags[u] = tag
		}
	}
	return true, nil
}

// redactQuery drops a URL's query for error messages.
func redactQuery(u string) string {
	path, _, _ := strings.Cut(u, "?")
	return path
}
