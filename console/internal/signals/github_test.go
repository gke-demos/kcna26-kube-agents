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
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/model"
)

const testRepo = "gke-demos/kcna26-fleet-gitops"

// fakeGitHub serves PRs, audit issues, PR files and PR details, with ETags.
type fakeGitHub struct {
	mu     sync.Mutex
	pulls  []map[string]any
	issues []map[string]any
	files  map[string][]string
	calls  map[string]int
}

func (f *fakeGitHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer ghp-test" || r.Header.Get("X-GitHub-Api-Version") != githubAPIVersion {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	p := strings.TrimPrefix(r.URL.Path, "/repos/"+testRepo)
	f.calls[p]++
	var body any
	switch {
	case p == "/pulls":
		body = f.pulls
	case p == "/issues":
		if r.URL.Query().Get("labels") != auditLabel {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		body = f.issues
	case strings.HasSuffix(p, "/files"):
		var out []map[string]string
		for _, fn := range f.files[strings.TrimSuffix(strings.TrimPrefix(p, "/pulls/"), "/files")] {
			out = append(out, map[string]string{"filename": fn})
		}
		body = out
	case strings.HasPrefix(p, "/pulls/"):
		body = map[string]any{"merged_by": map[string]string{"login": "garisingh"}}
	default:
		w.WriteHeader(http.StatusNotFound)
		return
	}
	b, _ := json.Marshal(body)
	tag := fmt.Sprintf(`"%x"`, sha256.Sum256(b))
	if r.Header.Get("If-None-Match") == tag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("ETag", tag)
	_, _ = w.Write(b)
}

func pull(n int, state, ref, title, created string, merged, closed any) map[string]any {
	updated := created
	if closed != nil {
		updated = closed.(string)
	}
	return map[string]any{
		"number": n, "state": state, "title": title, "html_url": fmt.Sprintf("https://github.com/%s/pull/%d", testRepo, n),
		"user": map[string]string{"login": "kube-agents-platform-agent[bot]"}, "head": map[string]string{"ref": ref},
		"created_at": created, "updated_at": updated, "merged_at": merged, "closed_at": closed,
	}
}

func issue(n int, title, updated string) map[string]any {
	return map[string]any{
		"number": n, "title": title, "html_url": fmt.Sprintf("https://github.com/%s/issues/%d", testRepo, n),
		"user": map[string]string{"login": "kube-agents-platform-agent[bot]"}, "created_at": updated, "updated_at": updated,
	}
}

func TestGitHubTransitions(t *testing.T) {
	f := &fakeGitHub{calls: map[string]int{}, files: map[string][]string{
		"1": {"clusters/boutique-prod/namespaces/online-boutique/recommendationservice.yaml"},
		"5": {"README.md", "clusters/boutique-prod/namespaces/online-boutique/frontend-pdb.yaml"},
		"7": {"clusters/bank-prod/namespaces/bank-of-anthos/ledger-db.yaml"},
	}}
	f.pulls = []map[string]any{
		pull(5, "open", "platform-agent/fix-obtainability-audit-frontend-pdb-e405702065", "fix(obtainability-audit): no-pdb on Deployment/frontend", "2026-11-02T18:42:52Z", nil, nil),
		pull(1, "closed", "platform-agent/increase-recommendationservice-memory", "chore(online-boutique): increase recommendationservice memory requests and limits to 64Mi", "2026-11-02T18:16:39Z", "2026-11-02T18:25:14Z", "2026-11-02T18:25:14Z"),
		pull(0, "closed", "old", "an old PR", "2026-10-20T10:00:00Z", nil, "2026-10-21T10:00:00Z"),
	}
	f.issues = []map[string]any{
		issue(2, "[audit] Fleet Waste Audit — 16 findings (0 critical)", "2026-11-02T18:23:43Z"),
		func() map[string]any {
			m := issue(5, "fix(obtainability-audit): no-pdb on Deployment/frontend", "2026-11-02T18:42:54Z")
			m["pull_request"] = map[string]string{"url": "x"}
			return m
		}(),
	}
	srv := httptest.NewServer(f)
	defer srv.Close()

	g := NewGitHub(GitHubOptions{Token: "ghp-test", Repo: testRepo, AuditBranchPrefix: "platform-agent/fix-"})
	g.api = srv.URL
	g.now = func() time.Time { return time.Date(2026, 11, 3, 1, 0, 0, 0, time.UTC) }
	g.reset()
	drawn := map[string]bool{"boutique-prod/recommendationservice": true, "boutique-prod/frontend": true}
	resolve := func(c, n string) (string, bool) { k := model.Key(c, n); return k, drawn[k] }
	rec := &recorder{}
	ctx := context.Background()

	if err := g.poll(ctx, rec, resolve); err != nil {
		t.Fatal(err)
	}
	evs := rec.take()
	if got := strings.Join(types(evs), ","); got != "pr_opened,audit,pr_merged,audit" {
		t.Fatalf("start: %s", got)
	}
	opened, merged, auditPR := evs[0], evs[2], evs[3]
	if opened.Key != "boutique-prod/recommendationservice" || opened.Cluster != "boutique-prod" ||
		opened.Title != "PR #1 opened: chore(online-boutique): increase recommendationservice memory requests and limits to 64Mi" ||
		opened.Actor != "kube-agents-platform-agent[bot]" || !opened.Time.Equal(time.Date(2026, 11, 2, 18, 16, 39, 0, time.UTC)) {
		t.Errorf("opened %+v", opened)
	}
	if merged.Actor != "garisingh" || merged.Link != "https://github.com/"+testRepo+"/pull/1" || merged.Key != opened.Key {
		t.Errorf("merged %+v", merged)
	}
	if auditPR.Key != "boutique-prod/frontend" || !strings.HasPrefix(auditPR.Title, "Audit PR #5 opened") {
		t.Errorf("audit PR %+v", auditPR)
	}
	if evs[1].Title != "[audit] Fleet Waste Audit — 16 findings (0 critical)" || evs[1].Link != "https://github.com/"+testRepo+"/issues/2" {
		t.Errorf("issue %+v", evs[1])
	}

	// Unchanged: 304s, nothing emitted, files not re-read.
	if err := g.poll(ctx, rec, resolve); err != nil {
		t.Fatal(err)
	}
	if evs := rec.take(); len(evs) != 0 {
		t.Errorf("unchanged poll emitted %v", types(evs))
	}

	// A new PR, then it is closed unmerged; the audit issue is updated.
	f.mu.Lock()
	f.pulls = append([]map[string]any{pull(7, "open", "fix-ledger", "fix ledger-db", "2026-11-03T00:59:00Z", nil, nil)}, f.pulls...)
	f.mu.Unlock()
	if err := g.poll(ctx, rec, resolve); err != nil {
		t.Fatal(err)
	}
	evs = rec.take()
	if got := strings.Join(types(evs), ","); got != "pr_opened" {
		t.Fatalf("new PR: %s", got)
	}
	if evs[0].Cluster != "bank-prod" || evs[0].Key != "" {
		t.Errorf("unresolved PR %+v", evs[0])
	}
	f.mu.Lock()
	f.pulls[0] = pull(7, "closed", "fix-ledger", "fix ledger-db", "2026-11-03T00:59:00Z", nil, "2026-11-03T01:00:30Z")
	f.issues[0] = issue(2, "[audit] Fleet Waste Audit — 15 findings (0 critical)", "2026-11-03T01:00:40Z")
	f.mu.Unlock()
	if err := g.poll(ctx, rec, resolve); err != nil {
		t.Fatal(err)
	}
	evs = rec.take()
	if got := strings.Join(types(evs), ","); got != "pr_closed,audit" {
		t.Fatalf("close: %s", got)
	}
	if evs[1].Title != "[audit] Fleet Waste Audit — 15 findings (0 critical)" {
		t.Errorf("issue update %+v", evs[1])
	}
	for _, n := range []string{"1", "5", "7"} {
		if c := f.calls["/pulls/"+n+"/files"]; c != 1 {
			t.Errorf("PR %s files read %d times", n, c)
		}
	}
}
