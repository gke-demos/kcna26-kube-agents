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

// Package actions runs the console's buttons as commits to the fleet repo,
// over the GitHub REST API (the image has no git). Each incident is a commit
// Config Sync applies, as in scripts/trigger-*.sh; reset restores clusters/
// to the baseline tag in one commit and closes the incident PRs, as in
// scripts/reset.sh.
package actions

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/server"
)

const (
	// Action names, as the server routes them.
	ActionOOM           = "trigger-oom"
	ActionBadImage      = "trigger-badimage"
	ActionUnschedulable = "trigger-unschedulable"
	ActionReset         = "reset"

	titleOOM           = "OOMKill a service (squeeze memory)"
	titleBadImage      = "Roll out a missing image tag"
	titleUnschedulable = "Make a service unschedulable (32 CPUs)"
	titleReset         = "Reset the demo"

	defaultBaseURL     = "https://api.github.com"
	defaultBranch      = "main"
	defaultBaselineTag = "baseline"
	defaultAuditPrefix = "platform-agent/fix-"

	headerAuthorization = "Authorization"
	headerAccept        = "Accept"
	headerAPIVersion    = "X-GitHub-Api-Version"
	headerContentType   = "Content-Type"
	bearerPrefix        = "Bearer "
	acceptGitHubJSON    = "application/vnd.github+json"
	githubAPIVersion    = "2022-11-28"
	contentTypeJSON     = "application/json"
	// maxErrorBody caps how much of a GitHub error response is read.
	maxErrorBody = 1 << 12

	boutiqueCluster = "boutique-prod"
	bankCluster     = "bank-prod"
	boutiqueDir     = "clusters/boutique-prod/namespaces/online-boutique"
	bankDir         = "clusters/bank-prod/namespaces/bank-of-anthos"
	manifestSuffix  = ".yaml"
	// clustersDir is the top-level tree reset swaps for the baseline's.
	clustersDir = "clusters"
	treeMode    = "040000"
	objTree     = "tree"
	objTag      = "tag"
	objCommit   = "commit"
	// maxTagDepth bounds the chain of annotated tags reset peels.
	maxTagDepth = 4

	// The OOM trigger: below what the runtimes need to start (see
	// scripts/trigger-oom.sh for the measurement).
	squeezedMemory = "20Mi"
	oomSubjectFmt  = "perf(%s): right-size memory to %s"
	oomBody        = "Profiling showed steady-state usage well under the old request."
	oomTitleFmt    = "%s on %s squeezed to %s"

	// The bad-image trigger: a plausible next patch the registry lacks.
	upstreamTag        = "v0.10.7"
	missingTag         = "v0.10.70"
	badImageSubjectFmt = "chore(%s): roll out %s"
	badImageTitleFmt   = "%s on %s rolled out to %s (no such tag)"

	// The unschedulable trigger: more CPU than an e2-standard-4 node has.
	reservedCPU             = "32"
	unschedulableSubjectFmt = "perf(%s): reserve %s CPUs for the holiday peak"
	unschedulableTitleFmt   = "%s on %s now requests %s CPUs"

	resetMessage      = "chore: restore demo baseline"
	resetComment      = "Closed by the demo reset (fleet-scope console)."
	resetTitleFmt     = "reset: clusters/ %s, closed %d %s"
	resetRestored     = "back to baseline"
	resetAlready      = "already at baseline"
	prSingular        = "PR"
	prPlural          = "PRs"
	prPageSize        = 100
	prStateOpen       = "open"
	prStateClosed     = "closed"
	trailerFmt        = "Pressed-by: %s"
	unknownPresser    = "unknown"
	errAlreadyFmt     = "%s already has %s: run reset first"
	errNotAtUpstream  = "%s is not at %s: run reset first"
	errNoWorkloadFmt  = "no Deployment or StatefulSet named %s"
	errNoSettingFmt   = "no %s settings on %s"
	settingMemory     = "memory"
	settingCPU        = "cpu"
	docSeparator      = "\n---\n"
	workloadKindRegex = `(?m)^kind: (Deployment|StatefulSet)$`
	nameLineRegexFmt  = `(?m)^  name: %s$`
	settingRegexFmt   = `(\n\s+%s: )\S+`
	// imageRegexFmt matches "/<name>:<tag>" ending the tag, so v0.10.7 does
	// not match the v0.10.70 it is turned into.
	imageRegexFmt = `/%s:%s([^\w.-]|$)`

	pathContents   = "/repos/%s/contents/%s"
	pathRef        = "/repos/%s/git/ref/%s"
	pathRefs       = "/repos/%s/git/refs/%s"
	pathCommit     = "/repos/%s/git/commits/%s"
	pathCommits    = "/repos/%s/git/commits"
	pathTree       = "/repos/%s/git/trees/%s"
	pathTrees      = "/repos/%s/git/trees"
	pathTag        = "/repos/%s/git/tags/%s"
	pathPulls      = "/repos/%s/pulls?state=%s&per_page=%d&page=%d"
	pathPull       = "/repos/%s/pulls/%d"
	pathIssueCmts  = "/repos/%s/issues/%d/comments"
	refHeadsPrefix = "heads/"
	refTagsPrefix  = "tags/"
	contentsRefArg = "?ref="
	pathSeparator  = "/"
	encodingBase64 = "base64"
	// commitURLMarker precedes the SHA in a commit's html_url.
	commitURLMarker = "/commit/"
	subjectBodyGlue = "\n\n"
)

// workload is where a target's manifest lives.
type workload struct{ cluster, dir string }

var (
	workloads = map[string]workload{
		"recommendationservice": {boutiqueCluster, boutiqueDir},
		"emailservice":          {boutiqueCluster, boutiqueDir},
		"currencyservice":       {boutiqueCluster, boutiqueDir},
		"frontend":              {boutiqueCluster, boutiqueDir},
		"checkoutservice":       {boutiqueCluster, boutiqueDir},
		"productcatalogservice": {boutiqueCluster, boutiqueDir},
		"cartservice":           {boutiqueCluster, boutiqueDir},
		"userservice":           {bankCluster, bankDir},
		"contacts":              {bankCluster, bankDir},
	}
	// Python and Node services only: a JVM exits with its own OutOfMemoryError
	// instead of being OOMKilled (scripts/trigger-oom.sh).
	oomTargets           = []string{"recommendationservice", "emailservice", "currencyservice", "userservice", "contacts"}
	badImageTargets      = []string{"frontend", "checkoutservice", "productcatalogservice"}
	unschedulableTargets = []string{"frontend", "productcatalogservice", "cartservice", "contacts"}

	workloadKind  = regexp.MustCompile(workloadKindRegex)
	memorySetting = regexp.MustCompile(fmt.Sprintf(settingRegexFmt, settingMemory))
	cpuSetting    = regexp.MustCompile(fmt.Sprintf(settingRegexFmt, settingCPU))
)

// Options configures the runner.
type Options struct {
	Token string
	// Repo is owner/name; Branch the one Config Sync reads.
	Repo   string
	Branch string
	// BaselineTag is what reset restores clusters/ to.
	BaselineTag string
	// AuditBranchPrefix marks PRs reset leaves open.
	AuditBranchPrefix string
	// HTTPClient defaults to http.DefaultClient; BaseURL to the GitHub API.
	HTTPClient *http.Client
	BaseURL    string
}

// Runner implements server.Actioner.
type Runner struct {
	o Options
	// sem serializes Run: two quick presses must not race on one file's sha
	// or the branch head.
	sem chan struct{}
}

// New returns a runner.
func New(o Options) *Runner {
	if o.HTTPClient == nil {
		o.HTTPClient = http.DefaultClient
	}
	if o.BaseURL == "" {
		o.BaseURL = defaultBaseURL
	}
	o.BaseURL = strings.TrimRight(o.BaseURL, pathSeparator)
	if o.Branch == "" {
		o.Branch = defaultBranch
	}
	if o.BaselineTag == "" {
		o.BaselineTag = defaultBaselineTag
	}
	if o.AuditBranchPrefix == "" {
		o.AuditBranchPrefix = defaultAuditPrefix
	}
	return &Runner{o: o, sem: make(chan struct{}, 1)}
}

// Actions implements server.Actioner.
func (r *Runner) Actions() []server.ActionSpec {
	return []server.ActionSpec{
		{Name: ActionOOM, Title: titleOOM, Targets: slices.Clone(oomTargets)},
		{Name: ActionBadImage, Title: titleBadImage, Targets: slices.Clone(badImageTargets)},
		{Name: ActionUnschedulable, Title: titleUnschedulable, Targets: slices.Clone(unschedulableTargets)},
		{Name: ActionReset, Title: titleReset},
	}
}

// Run implements server.Actioner: do, plus what the console needs to follow
// the press (the workload, its cluster and the commit Config Sync will apply).
func (r *Runner) Run(ctx context.Context, action, target, by string) (server.ActionResult, error) {
	title, link, err := r.do(ctx, action, target, by)
	res := server.ActionResult{Title: title, Link: link}
	if i := strings.LastIndex(link, commitURLMarker); i >= 0 {
		res.Commit = link[i+len(commitURLMarker):]
	}
	if w, ok := workloads[target]; ok && target != "" {
		res.Cluster = w.cluster
		res.Key = w.cluster + pathSeparator + target
	}
	return res, err
}

// do runs one action and returns its title and commit link.
func (r *Runner) do(ctx context.Context, action, target, by string) (string, string, error) {
	var targets []string
	switch action {
	case ActionOOM:
		targets = oomTargets
	case ActionBadImage:
		targets = badImageTargets
	case ActionUnschedulable:
		targets = unschedulableTargets
	case ActionReset:
		if target != "" {
			return "", "", fmt.Errorf("%s takes no target", action)
		}
	default:
		return "", "", fmt.Errorf("unknown action %q", action)
	}
	if action != ActionReset && !slices.Contains(targets, target) {
		return "", "", fmt.Errorf("%s cannot target %q (one of %s)", action, target, strings.Join(targets, ", "))
	}
	if r.o.Repo == "" {
		return "", "", errors.New("no fleet repo configured")
	}

	select {
	case r.sem <- struct{}{}:
	case <-ctx.Done():
		return "", "", ctx.Err()
	}
	defer func() { <-r.sem }()

	trailer := fmt.Sprintf(trailerFmt, presser(by))
	w := workloads[target]
	switch action {
	case ActionOOM:
		msg := fmt.Sprintf(oomSubjectFmt, target, squeezedMemory) + subjectBodyGlue + oomBody + subjectBodyGlue + trailer
		link, err := r.editFile(ctx, w.path(target), msg, func(text string) (string, error) {
			return setInWorkload(text, target, memorySetting, settingMemory, squeezedMemory)
		})
		return fmt.Sprintf(oomTitleFmt, target, w.cluster, squeezedMemory), link, err
	case ActionBadImage:
		msg := fmt.Sprintf(badImageSubjectFmt, target, missingTag) + subjectBodyGlue + trailer
		link, err := r.editFile(ctx, w.path(target), msg, func(text string) (string, error) {
			return retag(text, target, upstreamTag, missingTag)
		})
		return fmt.Sprintf(badImageTitleFmt, target, w.cluster, missingTag), link, err
	case ActionUnschedulable:
		msg := fmt.Sprintf(unschedulableSubjectFmt, target, reservedCPU) + subjectBodyGlue + trailer
		link, err := r.editFile(ctx, w.path(target), msg, func(text string) (string, error) {
			return setInWorkload(text, target, cpuSetting, settingCPU, reservedCPU)
		})
		return fmt.Sprintf(unschedulableTitleFmt, target, w.cluster, reservedCPU), link, err
	default:
		return r.reset(ctx, resetMessage+subjectBodyGlue+trailer)
	}
}

func (w workload) path(name string) string { return w.dir + pathSeparator + name + manifestSuffix }

// presser is the trailer's value: one line, never empty, so the identity
// cannot add trailers of its own.
func presser(by string) string {
	by = strings.TrimSpace(strings.NewReplacer("\r", "", "\n", "").Replace(by))
	if by == "" {
		return unknownPresser
	}
	return by
}

// setInWorkload sets every "<setting>: <x>" in the Deployment or StatefulSet
// document named name to value (requests and limits together: a limit below
// the request fails the sync instead of breaking the pod). It is
// tools/squeeze_memory.py in Go, and fails when nothing would change.
func setInWorkload(text, name string, setting *regexp.Regexp, settingName, value string) (string, error) {
	nameLine := regexp.MustCompile(fmt.Sprintf(nameLineRegexFmt, regexp.QuoteMeta(name)))
	docs := strings.Split(text, docSeparator)
	for i, doc := range docs {
		if !workloadKind.MatchString(doc) || !nameLine.MatchString(doc) {
			continue
		}
		if !setting.MatchString(doc) {
			return "", fmt.Errorf(errNoSettingFmt, settingName, name)
		}
		docs[i] = setting.ReplaceAllString(doc, "${1}"+value)
		out := strings.Join(docs, docSeparator)
		if out == text {
			return "", fmt.Errorf(errAlreadyFmt, name, settingName+": "+value)
		}
		return out, nil
	}
	return "", fmt.Errorf(errNoWorkloadFmt, name)
}

// retag moves "/<name>:<from>" images to <to>, refusing when the file is not
// at <from> (already moved, or someone else's change).
func retag(text, name, from, to string) (string, error) {
	image := regexp.MustCompile(fmt.Sprintf(imageRegexFmt, regexp.QuoteMeta(name), regexp.QuoteMeta(from)))
	if !image.MatchString(text) {
		return "", fmt.Errorf(errNotAtUpstream, name, from)
	}
	return image.ReplaceAllString(text, pathSeparator+name+":"+to+"${1}"), nil
}

// editFile reads path on the branch, applies edit, and commits the result
// with message, returning the commit's URL.
func (r *Runner) editFile(ctx context.Context, path, message string, edit func(string) (string, error)) (string, error) {
	var file struct {
		SHA      string `json:"sha"`
		Content  string `json:"content"`
		Encoding string `json:"encoding"`
	}
	if err := r.call(ctx, http.MethodGet, r.repoPath(pathContents, escapePath(path))+contentsRefArg+url.QueryEscape(r.o.Branch), nil, &file); err != nil {
		return "", fmt.Errorf("read %s: %w", path, err)
	}
	if file.Encoding != encodingBase64 {
		return "", fmt.Errorf("read %s: unexpected encoding %q", path, file.Encoding)
	}
	raw, err := base64.StdEncoding.DecodeString(strings.NewReplacer("\n", "", "\r", "").Replace(file.Content))
	if err != nil {
		return "", fmt.Errorf("decode %s: %w", path, err)
	}
	edited, err := edit(string(raw))
	if err != nil {
		return "", err
	}
	body := map[string]string{
		"message": message,
		"content": base64.StdEncoding.EncodeToString([]byte(edited)),
		"sha":     file.SHA,
		"branch":  r.o.Branch,
	}
	var out struct {
		Commit struct {
			HTMLURL string `json:"html_url"`
		} `json:"commit"`
	}
	if err := r.call(ctx, http.MethodPut, r.repoPath(pathContents, escapePath(path)), body, &out); err != nil {
		return "", fmt.Errorf("commit %s: %w", path, err)
	}
	return out.Commit.HTMLURL, nil
}

type gitObject struct {
	SHA  string `json:"sha"`
	Type string `json:"type"`
}

type treeEntry struct {
	Path string `json:"path"`
	Mode string `json:"mode"`
	Type string `json:"type"`
	SHA  string `json:"sha"`
}

type commitObject struct {
	SHA       string    `json:"sha"`
	HTMLURL   string    `json:"html_url"`
	Tree      gitObject `json:"tree"`
	Committer struct {
		Date time.Time `json:"date"`
	} `json:"committer"`
}

// heads reads the branch head commit and the clusters/ tree SHAs of the head
// and of the baseline tag.
func (r *Runner) heads(ctx context.Context) (head commitObject, headClusters, baseClusters string, err error) {
	var ref struct {
		Object gitObject `json:"object"`
	}
	if err = r.call(ctx, http.MethodGet, r.repoPath(pathRef, escapePath(refHeadsPrefix+r.o.Branch)), nil, &ref); err != nil {
		return head, "", "", fmt.Errorf("read %s: %w", r.o.Branch, err)
	}
	if head, err = r.commit(ctx, ref.Object.SHA); err != nil {
		return head, "", "", err
	}
	if headClusters, err = r.clustersEntry(ctx, head.Tree.SHA); err != nil {
		return head, "", "", fmt.Errorf("%s: %w", r.o.Branch, err)
	}
	baseCommitSHA, err := r.tagCommit(ctx, r.o.BaselineTag)
	if err != nil {
		return head, "", "", err
	}
	baseCommit, err := r.commit(ctx, baseCommitSHA)
	if err != nil {
		return head, "", "", err
	}
	if baseClusters, err = r.clustersEntry(ctx, baseCommit.Tree.SHA); err != nil {
		return head, "", "", fmt.Errorf("%s: %w", r.o.BaselineTag, err)
	}
	if baseClusters == "" {
		return head, "", "", fmt.Errorf("%s has no %s/ tree", r.o.BaselineTag, clustersDir)
	}
	return head, headClusters, baseClusters, nil
}

// Drift reports whether clusters/ on the branch differs from the baseline
// tag, and when the branch head was committed (a press, a merge, a reset).
func (r *Runner) Drift(ctx context.Context) (off bool, headAt time.Time, err error) {
	head, headClusters, baseClusters, err := r.heads(ctx)
	if err != nil {
		return false, time.Time{}, err
	}
	return headClusters != baseClusters, head.Committer.Date, nil
}

// reset swaps clusters/ for the baseline tag's in one commit (dropping files
// added since), then closes every open PR not opened by the audits.
func (r *Runner) reset(ctx context.Context, message string) (string, string, error) {
	headCommit, headClusters, baseClusters, err := r.heads(ctx)
	if err != nil {
		return "", "", err
	}

	state, link := resetAlready, headCommit.HTMLURL
	if baseClusters != headClusters {
		var tree gitObject
		treeReq := map[string]any{
			"base_tree": headCommit.Tree.SHA,
			"tree":      []treeEntry{{Path: clustersDir, Mode: treeMode, Type: objTree, SHA: baseClusters}},
		}
		if err := r.call(ctx, http.MethodPost, r.repoPath(pathTrees), treeReq, &tree); err != nil {
			return "", "", fmt.Errorf("build tree: %w", err)
		}
		var created commitObject
		commitReq := map[string]any{"message": message, "tree": tree.SHA, "parents": []string{headCommit.SHA}}
		if err := r.call(ctx, http.MethodPost, r.repoPath(pathCommits), commitReq, &created); err != nil {
			return "", "", fmt.Errorf("create commit: %w", err)
		}
		refReq := map[string]any{"sha": created.SHA, "force": false}
		if err := r.call(ctx, http.MethodPatch, r.repoPath(pathRefs, escapePath(refHeadsPrefix+r.o.Branch)), refReq, nil); err != nil {
			return "", "", fmt.Errorf("move %s to %s: %w", r.o.Branch, created.SHA, err)
		}
		state, link = resetRestored, created.HTMLURL
	}

	closed, err := r.closeIncidentPRs(ctx)
	noun := prPlural
	if closed == 1 {
		noun = prSingular
	}
	title := fmt.Sprintf(resetTitleFmt, state, closed, noun)
	if err != nil {
		return title, link, fmt.Errorf("%s, then: %w", title, err)
	}
	return title, link, nil
}

func (r *Runner) commit(ctx context.Context, sha string) (commitObject, error) {
	var c commitObject
	if err := r.call(ctx, http.MethodGet, r.repoPath(pathCommit, sha), nil, &c); err != nil {
		return c, fmt.Errorf("read commit %s: %w", sha, err)
	}
	return c, nil
}

// clustersEntry returns the SHA of the clusters/ tree in a root tree, or ""
// when it has none.
func (r *Runner) clustersEntry(ctx context.Context, treeSHA string) (string, error) {
	var tree struct {
		Tree []treeEntry `json:"tree"`
	}
	if err := r.call(ctx, http.MethodGet, r.repoPath(pathTree, treeSHA), nil, &tree); err != nil {
		return "", fmt.Errorf("read tree %s: %w", treeSHA, err)
	}
	for _, e := range tree.Tree {
		if e.Path == clustersDir && e.Type == objTree {
			return e.SHA, nil
		}
	}
	return "", nil
}

// tagCommit peels a tag (lightweight or annotated) to its commit.
func (r *Runner) tagCommit(ctx context.Context, tag string) (string, error) {
	var ref struct {
		Object gitObject `json:"object"`
	}
	if err := r.call(ctx, http.MethodGet, r.repoPath(pathRef, escapePath(refTagsPrefix+tag)), nil, &ref); err != nil {
		return "", fmt.Errorf("read tag %s: %w", tag, err)
	}
	obj := ref.Object
	for range maxTagDepth {
		switch obj.Type {
		case objCommit:
			return obj.SHA, nil
		case objTag:
			var t struct {
				Object gitObject `json:"object"`
			}
			if err := r.call(ctx, http.MethodGet, r.repoPath(pathTag, obj.SHA), nil, &t); err != nil {
				return "", fmt.Errorf("read tag object %s: %w", obj.SHA, err)
			}
			obj = t.Object
		default:
			return "", fmt.Errorf("tag %s points at a %s, not a commit", tag, obj.Type)
		}
	}
	return "", fmt.Errorf("tag %s: more than %d nested tags", tag, maxTagDepth)
}

type pullRequest struct {
	Number int `json:"number"`
	Head   struct {
		Ref  string `json:"ref"`
		Repo *struct {
			FullName string `json:"full_name"`
		} `json:"repo"`
	} `json:"head"`
}

// closeIncidentPRs closes every open PR whose branch lacks the audit prefix,
// with a comment, deleting its branch when it lives in the fleet repo. It
// carries on past a failure and returns how many it closed.
func (r *Runner) closeIncidentPRs(ctx context.Context) (int, error) {
	var open []pullRequest
	for page := 1; ; page++ {
		var batch []pullRequest
		if err := r.call(ctx, http.MethodGet, fmt.Sprintf(pathPulls, r.o.Repo, prStateOpen, prPageSize, page), nil, &batch); err != nil {
			return 0, fmt.Errorf("list PRs: %w", err)
		}
		open = append(open, batch...)
		if len(batch) < prPageSize {
			break
		}
	}
	closed := 0
	var errs []error
	for _, pr := range open {
		if strings.HasPrefix(pr.Head.Ref, r.o.AuditBranchPrefix) {
			continue
		}
		if err := r.call(ctx, http.MethodPost, fmt.Sprintf(pathIssueCmts, r.o.Repo, pr.Number), map[string]string{"body": resetComment}, nil); err != nil {
			errs = append(errs, fmt.Errorf("comment on #%d: %w", pr.Number, err))
			continue
		}
		if err := r.call(ctx, http.MethodPatch, fmt.Sprintf(pathPull, r.o.Repo, pr.Number), map[string]string{"state": prStateClosed}, nil); err != nil {
			errs = append(errs, fmt.Errorf("close #%d: %w", pr.Number, err))
			continue
		}
		closed++
		if pr.Head.Repo == nil || !strings.EqualFold(pr.Head.Repo.FullName, r.o.Repo) {
			continue
		}
		if err := r.call(ctx, http.MethodDelete, r.repoPath(pathRefs, escapePath(refHeadsPrefix+pr.Head.Ref)), nil, nil); err != nil {
			errs = append(errs, fmt.Errorf("delete branch %s of #%d: %w", pr.Head.Ref, pr.Number, err))
		}
	}
	return closed, errors.Join(errs...)
}

func (r *Runner) repoPath(format string, args ...any) string {
	return fmt.Sprintf(format, append([]any{r.o.Repo}, args...)...)
}

// escapePath escapes each segment of a slash-separated path.
func escapePath(p string) string {
	segs := strings.Split(p, pathSeparator)
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	return strings.Join(segs, pathSeparator)
}

// call sends one GitHub API request, decoding a JSON response into out when
// out is non-nil. Errors carry the status and GitHub's message, never the
// token.
func (r *Runner) call(ctx context.Context, method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, r.o.BaseURL+path, body)
	if err != nil {
		return err
	}
	req.Header.Set(headerAuthorization, bearerPrefix+r.o.Token)
	req.Header.Set(headerAccept, acceptGitHubJSON)
	req.Header.Set(headerAPIVersion, githubAPIVersion)
	if in != nil {
		req.Header.Set(headerContentType, contentTypeJSON)
	}
	resp, err := r.o.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		var e struct {
			Message string `json:"message"`
		}
		b, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody))
		if json.Unmarshal(b, &e) != nil || e.Message == "" {
			e.Message = strings.TrimSpace(string(b))
		}
		return fmt.Errorf("%s %s: %s: %s", method, path, resp.Status, e.Message)
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
