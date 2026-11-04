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
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	repo     = "gke-demos/kcna26-fleet-gitops"
	token    = "test-token"
	by       = "alice@example.com"
	recoPath = "clusters/boutique-prod/namespaces/online-boutique/recommendationservice.yaml"
	fePath   = "clusters/boutique-prod/namespaces/online-boutique/frontend.yaml"
)

type put struct{ path, message, content string }

type pr struct {
	number   int
	ref      string
	headRepo string
}

// fakeGitHub is the slice of the GitHub API the runner uses.
type fakeGitHub struct {
	t  *testing.T
	mu sync.Mutex

	// commitDate is every commit's committer date; zero leaves it out.
	commitDate time.Time

	files map[string]string
	puts  []put

	// reset state
	head          string
	commits       map[string]string // commit sha -> root tree sha
	trees         map[string][]treeEntry
	tagObj        string // annotated tag object sha
	tagCommit     string
	createdTrees  []map[string]any
	createdCommit []map[string]any
	refUpdates    []map[string]any

	pulls    []pr
	comments map[int]string
	closed   []int
	deleted  []string

	// onGet, when set, runs on every contents GET (outside mu).
	onGet func()
}

func sha(s string) string {
	h := sha1.Sum([]byte(s))
	return hex.EncodeToString(h[:])
}

func readFixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func newFake(t *testing.T) (*fakeGitHub, *Runner) {
	f := &fakeGitHub{
		t: t,
		files: map[string]string{
			recoPath: readFixture(t, "recommendationservice.yaml"),
			fePath:   readFixture(t, "frontend.yaml"),
		},
		commits:  map[string]string{},
		trees:    map[string][]treeEntry{},
		comments: map[int]string{},
	}
	mux := http.NewServeMux()
	p := "/repos/" + repo
	mux.HandleFunc("GET "+p+"/contents/{path...}", f.getContents)
	mux.HandleFunc("PUT "+p+"/contents/{path...}", f.putContents)
	mux.HandleFunc("GET "+p+"/git/ref/{ref...}", f.getRef)
	mux.HandleFunc("PATCH "+p+"/git/refs/{ref...}", f.patchRef)
	mux.HandleFunc("DELETE "+p+"/git/refs/{ref...}", f.deleteRef)
	mux.HandleFunc("GET "+p+"/git/commits/{sha}", f.getCommit)
	mux.HandleFunc("POST "+p+"/git/commits", f.postCommit)
	mux.HandleFunc("GET "+p+"/git/trees/{sha}", f.getTree)
	mux.HandleFunc("POST "+p+"/git/trees", f.postTree)
	mux.HandleFunc("GET "+p+"/git/tags/{sha}", f.getTag)
	mux.HandleFunc("GET "+p+"/pulls", f.listPulls)
	mux.HandleFunc("PATCH "+p+"/pulls/{n}", f.patchPull)
	mux.HandleFunc("POST "+p+"/issues/{n}/comments", f.postComment)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token ||
			r.Header.Get("Accept") != "application/vnd.github+json" ||
			r.Header.Get("X-GitHub-Api-Version") != "2022-11-28" {
			t.Errorf("%s %s: bad headers %v", r.Method, r.URL, r.Header)
		}
		mux.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	r := New(Options{Token: token, Repo: repo, Branch: "main", BaselineTag: "baseline",
		AuditBranchPrefix: "platform-agent/fix-", BaseURL: srv.URL + "/", HTTPClient: srv.Client()})
	return f, r
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func decode(t *testing.T, r *http.Request) map[string]any {
	var m map[string]any
	if err := json.NewDecoder(r.Body).Decode(&m); err != nil {
		t.Errorf("decode %s %s: %v", r.Method, r.URL, err)
	}
	return m
}

func (f *fakeGitHub) getContents(w http.ResponseWriter, r *http.Request) {
	if f.onGet != nil {
		f.onGet()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.URL.Query().Get("ref") != "main" {
		f.t.Errorf("contents read at ref %q", r.URL.Query().Get("ref"))
	}
	c, ok := f.files[r.PathValue("path")]
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"message": "Not Found"})
		return
	}
	// GitHub wraps the base64 at 60 columns.
	enc := base64.StdEncoding.EncodeToString([]byte(c))
	var wrapped strings.Builder
	for i := 0; i < len(enc); i += 60 {
		wrapped.WriteString(enc[i:min(i+60, len(enc))] + "\n")
	}
	writeJSON(w, http.StatusOK, map[string]string{"sha": sha(c), "content": wrapped.String(), "encoding": "base64"})
}

func (f *fakeGitHub) putContents(w http.ResponseWriter, r *http.Request) {
	m := decode(f.t, r)
	f.mu.Lock()
	defer f.mu.Unlock()
	path := r.PathValue("path")
	if m["sha"] != sha(f.files[path]) {
		writeJSON(w, http.StatusConflict, map[string]string{"message": "is at " + sha(f.files[path])})
		return
	}
	if m["branch"] != "main" {
		f.t.Errorf("put to branch %v", m["branch"])
	}
	b, err := base64.StdEncoding.DecodeString(m["content"].(string))
	if err != nil {
		f.t.Fatal(err)
	}
	f.files[path] = string(b)
	f.puts = append(f.puts, put{path, m["message"].(string), string(b)})
	n := len(f.puts)
	writeJSON(w, http.StatusOK, map[string]any{"commit": map[string]string{
		"sha": "c" + strconv.Itoa(n), "html_url": fmt.Sprintf("https://github.com/%s/commit/c%d", repo, n)}})
}

func (f *fakeGitHub) getRef(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch r.PathValue("ref") {
	case "heads/main":
		writeJSON(w, http.StatusOK, map[string]any{"object": map[string]string{"sha": f.head, "type": "commit"}})
	case "tags/baseline":
		writeJSON(w, http.StatusOK, map[string]any{"object": map[string]string{"sha": f.tagObj, "type": "tag"}})
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"message": "Not Found"})
	}
}

func (f *fakeGitHub) getTag(w http.ResponseWriter, r *http.Request) {
	if r.PathValue("sha") != f.tagObj {
		writeJSON(w, http.StatusNotFound, map[string]string{"message": "Not Found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"object": map[string]string{"sha": f.tagCommit, "type": "commit"}})
}

func (f *fakeGitHub) getCommit(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := r.PathValue("sha")
	tree, ok := f.commits[s]
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"message": "Not Found"})
		return
	}
	c := map[string]any{"sha": s, "html_url": "https://github.com/" + repo + "/commit/" + s,
		"tree": map[string]string{"sha": tree, "type": "tree"}}
	if !f.commitDate.IsZero() {
		c["committer"] = map[string]string{"date": f.commitDate.Format(time.RFC3339)}
	}
	writeJSON(w, http.StatusOK, c)
}

func (f *fakeGitHub) getTree(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	entries, ok := f.trees[r.PathValue("sha")]
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"message": "Not Found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sha": r.PathValue("sha"), "tree": entries})
}

func (f *fakeGitHub) postTree(w http.ResponseWriter, r *http.Request) {
	m := decode(f.t, r)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.createdTrees = append(f.createdTrees, m)
	writeJSON(w, http.StatusCreated, map[string]string{"sha": "newtree"})
}

func (f *fakeGitHub) postCommit(w http.ResponseWriter, r *http.Request) {
	m := decode(f.t, r)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.createdCommit = append(f.createdCommit, m)
	writeJSON(w, http.StatusCreated, map[string]string{"sha": "newcommit",
		"html_url": "https://github.com/" + repo + "/commit/newcommit"})
}

func (f *fakeGitHub) patchRef(w http.ResponseWriter, r *http.Request) {
	m := decode(f.t, r)
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.PathValue("ref") != "heads/main" {
		f.t.Errorf("patched ref %s", r.PathValue("ref"))
	}
	f.refUpdates = append(f.refUpdates, m)
	writeJSON(w, http.StatusOK, map[string]any{})
}

func (f *fakeGitHub) deleteRef(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted = append(f.deleted, r.PathValue("ref"))
	w.WriteHeader(http.StatusNoContent)
}

func (f *fakeGitHub) listPulls(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.URL.Query().Get("state") != "open" {
		f.t.Errorf("listed PRs in state %q", r.URL.Query().Get("state"))
	}
	var out []map[string]any
	if r.URL.Query().Get("page") == "1" {
		for _, p := range f.pulls {
			out = append(out, map[string]any{"number": p.number, "head": map[string]any{
				"ref": p.ref, "repo": map[string]string{"full_name": p.headRepo}}})
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (f *fakeGitHub) patchPull(w http.ResponseWriter, r *http.Request) {
	m := decode(f.t, r)
	f.mu.Lock()
	defer f.mu.Unlock()
	n, _ := strconv.Atoi(r.PathValue("n"))
	if m["state"] != "closed" {
		f.t.Errorf("PR %d patched to %v", n, m)
	}
	if _, ok := f.comments[n]; !ok {
		f.t.Errorf("PR %d closed before its comment", n)
	}
	f.closed = append(f.closed, n)
	writeJSON(w, http.StatusOK, map[string]any{})
}

func (f *fakeGitHub) postComment(w http.ResponseWriter, r *http.Request) {
	m := decode(f.t, r)
	f.mu.Lock()
	defer f.mu.Unlock()
	n, _ := strconv.Atoi(r.PathValue("n"))
	f.comments[n] = m["body"].(string)
	writeJSON(w, http.StatusCreated, map[string]any{})
}

func docs(s string) []string { return strings.Split(s, "\n---\n") }

func TestTriggerOOM(t *testing.T) {
	f, r := newFake(t)
	before := f.files[recoPath]
	title, link, err := r.do(context.Background(), "trigger-oom", "recommendationservice", by)
	if err != nil {
		t.Fatal(err)
	}
	if title != "recommendationservice on boutique-prod squeezed to 20Mi" {
		t.Errorf("title = %q", title)
	}
	if link != "https://github.com/"+repo+"/commit/c1" {
		t.Errorf("link = %q", link)
	}
	if len(f.puts) != 1 || f.puts[0].path != recoPath {
		t.Fatalf("puts = %+v", f.puts)
	}
	msg := f.puts[0].message
	if !strings.HasPrefix(msg, "perf(recommendationservice): right-size memory to 20Mi\n\n") ||
		!strings.HasSuffix(msg, "\n\nPressed-by: alice@example.com") {
		t.Errorf("message = %q", msg)
	}

	got, want := docs(f.puts[0].content), docs(before)
	if len(got) != 3 || len(got) != len(want) {
		t.Fatalf("doc count %d, want 3", len(got))
	}
	for i := 1; i < len(got); i++ {
		if got[i] != want[i] {
			t.Errorf("doc %d (not the Deployment) changed:\n%s", i, got[i])
		}
	}
	dep := got[0]
	for _, s := range []string{"            memory: 220Mi", "            memory: 450Mi"} {
		if strings.Contains(dep, s) {
			t.Errorf("Deployment still has %q", s)
		}
	}
	if n := strings.Count(dep, "            memory: 20Mi"); n != 2 {
		t.Errorf("Deployment has %d memory: 20Mi lines, want 2 (request and limit):\n%s", n, dep)
	}
	if strings.Count(dep, "cpu: 100m") != 1 || strings.Count(dep, "cpu: 200m") != 1 {
		t.Error("cpu settings changed")
	}
	if strings.ReplaceAll(dep, "memory: 20Mi", "memory: X") !=
		strings.ReplaceAll(strings.ReplaceAll(want[0], "memory: 220Mi", "memory: X"), "memory: 450Mi", "memory: X") {
		t.Error("Deployment changed beyond its memory values")
	}

	// A second press finds nothing to change.
	if _, _, err := r.do(context.Background(), "trigger-oom", "recommendationservice", by); err == nil ||
		!strings.Contains(err.Error(), "run reset first") {
		t.Errorf("second squeeze: err = %v", err)
	}
	if len(f.puts) != 1 {
		t.Errorf("second squeeze committed")
	}
}

func TestSetInWorkloadPicksTheWorkloadDoc(t *testing.T) {
	// The Service comes first and shares the name; a second Deployment has a
	// different one. Only the named Deployment changes.
	in := "apiVersion: v1\nkind: Service\nmetadata:\n  name: contacts\nspec:\n  x:\n    memory: 1Gi\n" +
		"---\nkind: Deployment\nmetadata:\n  name: contacts\nspec:\n  r:\n    requests:\n      memory: 64Mi\n    limits:\n      memory: 128Mi\n" +
		"---\nkind: StatefulSet\nmetadata:\n  name: contacts-db\nspec:\n  r:\n    memory: 1Gi\n"
	out, err := setInWorkload(in, "contacts", memorySetting, settingMemory, "20Mi")
	if err != nil {
		t.Fatal(err)
	}
	d := docs(out)
	if d[0] != docs(in)[0] || d[2] != docs(in)[2] {
		t.Errorf("other docs changed:\n%s", out)
	}
	if !strings.Contains(d[1], "requests:\n      memory: 20Mi\n    limits:\n      memory: 20Mi") {
		t.Errorf("deployment = %q", d[1])
	}
	if _, err := setInWorkload(in, "frontend", memorySetting, settingMemory, "20Mi"); err == nil {
		t.Error("missing workload: want error")
	}
}

func TestTriggerBadImage(t *testing.T) {
	f, r := newFake(t)
	title, link, err := r.do(context.Background(), "trigger-badimage", "frontend", by)
	if err != nil {
		t.Fatal(err)
	}
	if title != "frontend on boutique-prod rolled out to v0.10.70 (no such tag)" || link == "" {
		t.Errorf("title, link = %q, %q", title, link)
	}
	p := f.puts[0]
	if p.message != "chore(frontend): roll out v0.10.70\n\nPressed-by: alice@example.com" {
		t.Errorf("message = %q", p.message)
	}
	if !strings.Contains(p.content, "microservices-demo/frontend:v0.10.70\n") || strings.Contains(p.content, "frontend:v0.10.700") {
		t.Errorf("image not moved to v0.10.70")
	}
	if strings.Replace(p.content, ":v0.10.70\n", ":v0.10.7\n", 1) != readFixture(t, "frontend.yaml") {
		t.Error("file changed beyond the image tag")
	}

	// Already at v0.10.70: refuse rather than produce v0.10.700.
	if _, _, err := r.do(context.Background(), "trigger-badimage", "frontend", by); err == nil ||
		!strings.Contains(err.Error(), "not at v0.10.7") {
		t.Errorf("second rollout: err = %v", err)
	}
	if len(f.puts) != 1 {
		t.Error("second rollout committed")
	}
}

func TestTriggerUnschedulable(t *testing.T) {
	f, r := newFake(t)
	before := f.files[fePath]
	title, _, err := r.do(context.Background(), "trigger-unschedulable", "frontend", by)
	if err != nil {
		t.Fatal(err)
	}
	if title != "frontend on boutique-prod now requests 32 CPUs" {
		t.Errorf("title = %q", title)
	}
	p := f.puts[0]
	if p.message != "perf(frontend): reserve 32 CPUs for the holiday peak\n\nPressed-by: alice@example.com" {
		t.Errorf("message = %q", p.message)
	}
	got, want := docs(p.content), docs(before)
	if n := strings.Count(got[0], "cpu: 32"); n != 2 {
		t.Errorf("Deployment has %d cpu: 32 lines, want 2", n)
	}
	if strings.Contains(got[0], "cpu: 100m") || strings.Contains(got[0], "cpu: 200m") {
		t.Error("old cpu values remain")
	}
	if !strings.Contains(got[0], "memory: 64Mi") || !strings.Contains(got[0], "memory: 128Mi") {
		t.Error("memory changed")
	}
	for i := 1; i < len(got); i++ {
		if got[i] != want[i] {
			t.Errorf("doc %d changed", i)
		}
	}
	if _, _, err := r.do(context.Background(), "trigger-unschedulable", "frontend", by); err == nil ||
		!strings.Contains(err.Error(), "run reset first") {
		t.Errorf("second press: err = %v", err)
	}
}

func TestTargetValidation(t *testing.T) {
	f, r := newFake(t)
	for _, c := range []struct{ action, target string }{
		{"trigger-oom", "frontend"},         // not an OOM target
		{"trigger-oom", ""},                 // missing
		{"trigger-badimage", "contacts"},    // bank has no v0.10.7 image
		{"trigger-unschedulable", "../etc"}, // not a target at all
		{"reset", "recommendationservice"},  // takes none
		{"delete-everything", "frontend"},   // no such action
		{"trigger-oom", "recommendationservice/../frontend"},
	} {
		if _, _, err := r.do(context.Background(), c.action, c.target, by); err == nil {
			t.Errorf("Run(%q, %q): want error", c.action, c.target)
		}
	}
	if len(f.puts) != 0 {
		t.Errorf("invalid runs committed: %+v", f.puts)
	}
	for _, a := range r.Actions() {
		if a.Name == "reset" {
			if len(a.Targets) != 0 {
				t.Error("reset lists targets")
			}
			continue
		}
		for _, tg := range a.Targets {
			if _, ok := workloads[tg]; !ok {
				t.Errorf("%s target %s has no manifest path", a.Name, tg)
			}
		}
	}
}

func TestPressedByIsOneLine(t *testing.T) {
	f, r := newFake(t)
	if _, _, err := r.do(context.Background(), "trigger-badimage", "frontend", "eve@example.com\nSigned-off-by: x"); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(f.puts[0].message, "\n\nPressed-by: eve@example.comSigned-off-by: x") {
		t.Errorf("message = %q", f.puts[0].message)
	}
}

func seedReset(f *fakeGitHub, sameClusters bool) {
	f.head = "head1"
	f.commits["head1"] = "maintree"
	f.commits["base1"] = "basetree"
	f.tagObj = "tagobj"
	f.tagCommit = "base1"
	mainClusters := "clusters-main"
	if sameClusters {
		mainClusters = "clusters-base"
	}
	f.trees["maintree"] = []treeEntry{
		{Path: "README.md", Mode: "100644", Type: "blob", SHA: "readme"},
		{Path: "clusters", Mode: "040000", Type: "tree", SHA: mainClusters},
	}
	f.trees["basetree"] = []treeEntry{
		{Path: "README.md", Mode: "100644", Type: "blob", SHA: "readme-old"},
		{Path: "clusters", Mode: "040000", Type: "tree", SHA: "clusters-base"},
	}
	f.pulls = []pr{
		{7, "platform-agent/fix-pdb-checkout", repo},
		{9, "incident/oom-reco", repo},
		{11, "patch-1", "someone/fork"},
	}
}

func TestReset(t *testing.T) {
	f, r := newFake(t)
	seedReset(f, false)
	title, link, err := r.do(context.Background(), "reset", "", by)
	if err != nil {
		t.Fatal(err)
	}
	if title != "reset: clusters/ back to baseline, closed 2 PRs" {
		t.Errorf("title = %q", title)
	}
	if link != "https://github.com/"+repo+"/commit/newcommit" {
		t.Errorf("link = %q", link)
	}
	if len(f.createdTrees) != 1 {
		t.Fatalf("trees created: %d", len(f.createdTrees))
	}
	tr := f.createdTrees[0]
	if tr["base_tree"] != "maintree" {
		t.Errorf("base_tree = %v", tr["base_tree"])
	}
	entries := tr["tree"].([]any)
	if len(entries) != 1 {
		t.Fatalf("entries = %v", entries)
	}
	e := entries[0].(map[string]any)
	if e["path"] != "clusters" || e["mode"] != "040000" || e["type"] != "tree" || e["sha"] != "clusters-base" {
		t.Errorf("entry = %v", e)
	}
	if len(f.createdCommit) != 1 {
		t.Fatalf("commits created: %d", len(f.createdCommit))
	}
	c := f.createdCommit[0]
	if c["message"] != "chore: restore demo baseline\n\nPressed-by: alice@example.com" || c["tree"] != "newtree" {
		t.Errorf("commit = %v", c)
	}
	if ps := c["parents"].([]any); len(ps) != 1 || ps[0] != "head1" {
		t.Errorf("parents = %v", ps)
	}
	if len(f.refUpdates) != 1 || f.refUpdates[0]["sha"] != "newcommit" || f.refUpdates[0]["force"] != false {
		t.Errorf("ref updates = %v", f.refUpdates)
	}
	if fmt.Sprint(f.closed) != "[9 11]" {
		t.Errorf("closed = %v, want [9 11] (the audit PR stays open)", f.closed)
	}
	if f.comments[9] != "Closed by the demo reset (fleet-scope console)." {
		t.Errorf("comment = %q", f.comments[9])
	}
	if fmt.Sprint(f.deleted) != "[heads/incident/oom-reco]" {
		t.Errorf("deleted = %v (only the same-repo branch)", f.deleted)
	}
}

func TestResetAlreadyAtBaseline(t *testing.T) {
	f, r := newFake(t)
	seedReset(f, true)
	f.pulls = f.pulls[:2]
	title, link, err := r.do(context.Background(), "reset", "", by)
	if err != nil {
		t.Fatal(err)
	}
	if title != "reset: clusters/ already at baseline, closed 1 PR" {
		t.Errorf("title = %q", title)
	}
	if link != "https://github.com/"+repo+"/commit/head1" {
		t.Errorf("link = %q", link)
	}
	if len(f.createdTrees)+len(f.createdCommit)+len(f.refUpdates) != 0 {
		t.Errorf("wrote git objects: %v %v %v", f.createdTrees, f.createdCommit, f.refUpdates)
	}
	if fmt.Sprint(f.closed) != "[9]" {
		t.Errorf("closed = %v", f.closed)
	}
}

func TestRunIsSerialized(t *testing.T) {
	f, r := newFake(t)
	var (
		mu      sync.Mutex
		gets    int
		arrived = make(chan struct{}, 2)
		release = make(chan struct{})
	)
	f.onGet = func() {
		mu.Lock()
		gets++
		first := gets == 1
		mu.Unlock()
		arrived <- struct{}{}
		if first {
			<-release
		}
	}
	errs := make(chan error, 2)
	go func() {
		_, _, err := r.do(context.Background(), "trigger-oom", "recommendationservice", by)
		errs <- err
	}()
	<-arrived
	go func() {
		_, _, err := r.do(context.Background(), "trigger-oom", "recommendationservice", by)
		errs <- err
	}()
	select {
	case <-arrived:
		t.Fatal("second press reached GitHub while the first was in flight")
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	var failed int
	for range 2 {
		if err := <-errs; err != nil {
			failed++
			if !strings.Contains(err.Error(), "run reset first") {
				t.Errorf("err = %v", err)
			}
		}
	}
	// The second press read the first's result, not a stale sha.
	if failed != 1 || len(f.puts) != 1 {
		t.Errorf("failed = %d, puts = %d; want 1, 1", failed, len(f.puts))
	}
}

func TestRunGivesUpWaitingOnCancel(t *testing.T) {
	_, r := newFake(t)
	r.sem <- struct{}{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := r.do(ctx, "trigger-oom", "recommendationservice", by); err != context.Canceled {
		t.Errorf("err = %v, want context.Canceled", err)
	}
}

func TestGitHubErrorSurfacesWithoutToken(t *testing.T) {
	f, r := newFake(t)
	delete(f.files, recoPath)
	_, _, err := r.do(context.Background(), "trigger-oom", "recommendationservice", by)
	if err == nil || !strings.Contains(err.Error(), "404") || !strings.Contains(err.Error(), "Not Found") {
		t.Errorf("err = %v", err)
	}
	if strings.Contains(err.Error(), token) {
		t.Error("error carries the token")
	}
}

func TestRunReportsWhatToFollow(t *testing.T) {
	_, r := newFake(t)
	res, err := r.Run(context.Background(), "trigger-oom", "recommendationservice", by)
	if err != nil {
		t.Fatal(err)
	}
	if res.Key != "boutique-prod/recommendationservice" || res.Cluster != "boutique-prod" || res.Commit != "c1" {
		t.Fatalf("result = %+v", res)
	}
}
