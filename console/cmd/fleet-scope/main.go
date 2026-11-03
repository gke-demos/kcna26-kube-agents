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

// fleet-scope: a live 3D view of the KubeCon demo fleet and the kube-agents
// working on it, with buttons that break it on purpose.
package main

import (
	"context"
	"errors"
	"flag"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/actions"
	"github.com/gke-demos/kcna26-kube-agents/console/internal/collector"
	"github.com/gke-demos/kcna26-kube-agents/console/internal/fleet"
	"github.com/gke-demos/kcna26-kube-agents/console/internal/iap"
	"github.com/gke-demos/kcna26-kube-agents/console/internal/model"
	"github.com/gke-demos/kcna26-kube-agents/console/internal/server"
	"github.com/gke-demos/kcna26-kube-agents/console/internal/signals"
	"github.com/gke-demos/kcna26-kube-agents/console/web"
)

const (
	defaultAddr        = ":8080"
	defaultProject     = "kcna-2026-demos"
	defaultRepo        = "gke-demos/kcna26-fleet-gitops"
	defaultChannel     = "C0CEZ07K39N"
	defaultHub         = "kube-agents-hub"
	defaultAgentNS     = "kubeagents-system"
	defaultBaseline    = "baseline"
	defaultAuditPrefix = "platform-agent/fix-"
	sceneName          = "kcna-2026-demos fleet"
	shutdownGrace      = 5 * time.Second
	readHeaderTimeout  = 10 * time.Second
)

func main() {
	var (
		addr       = flag.String("addr", envOr("SCOPE_ADDR", defaultAddr), "listen address")
		project    = flag.String("project", envOr("SCOPE_PROJECT", defaultProject), "project whose clusters are drawn")
		projectNum = flag.String("project-number", envOr("SCOPE_PROJECT_NUMBER", ""), "project number, for IAP's audience; required unless --dev-identity")
		devID      = flag.String("dev-identity", "", "skip IAP and treat every request as this email (local development only)")
		writers    = flag.String("writers", envOr("SCOPE_WRITERS", ""), "comma-separated emails or domain:example.com that may press buttons")
		origins    = flag.String("allowed-origins", envOr("SCOPE_ALLOWED_ORIGINS", ""), "extra host patterns allowed to open the stream")
		webDir     = flag.String("web-dir", "", "serve the front end from this directory instead of the embedded copy")
		hub        = flag.String("hub", defaultHub, "the cluster kube-agents runs on")
		agentNS    = flag.String("agent-namespace", defaultAgentNS, "kube-agents' namespace on the hub")
		repo       = flag.String("repo", envOr("SCOPE_REPO", defaultRepo), "fleet GitOps repo, owner/name")
		branch     = flag.String("branch", "main", "branch Config Sync reads")
		baseline   = flag.String("baseline-tag", defaultBaseline, "tag reset restores clusters/ to")
		auditPfx   = flag.String("audit-branch-prefix", defaultAuditPrefix, "branch prefix of the audits' PRs (reset leaves them open)")
		ghToken    = flag.String("github-token-file", envOr("SCOPE_GITHUB_TOKEN_FILE", ""), "fine-grained PAT on the fleet repo; empty disables GitHub signals and buttons")
		slackToken = flag.String("slack-token-file", envOr("SCOPE_SLACK_TOKEN_FILE", ""), "Slack bot token; empty disables Slack signals")
		channel    = flag.String("slack-channel", envOr("SCOPE_SLACK_CHANNEL", defaultChannel), "channel the agent posts alerts to")
		links      = flag.String("links", envOr("SCOPE_LINKS", ""), "header links, name=url comma-separated")
	)
	flag.Parse()
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, nil)))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var auth server.Identifier
	if *devID != "" {
		slog.Warn("IAP disabled: every request is treated as --dev-identity", "identity", *devID)
		auth = iap.Fixed(*devID)
	} else {
		v, err := iap.New(*projectNum)
		if err != nil {
			fatal("iap", err)
		}
		auth = v
	}

	store := collector.NewStore(collector.Options{
		Cluster:  sceneName,
		Source:   "fleet",
		Features: model.Features{Links: parseLinks(*links)},
	})
	// Always a key: at startup the signal pollers' first load can run before
	// the fleet source has drawn anything, and the front end skips effects
	// for workloads it isn't drawing anyway.
	resolve := func(cluster, name string) (string, bool) {
		return model.Key(cluster, name), cluster != "" && name != ""
	}

	run := func(name string, f func(context.Context) error) {
		go func() {
			if err := f(ctx); err != nil && !errors.Is(err, context.Canceled) {
				slog.Error("source stopped", "source", name, "err", err)
			}
		}()
	}

	src := fleet.New(fleet.Options{Project: *project, Hub: *hub, AgentNamespace: *agentNS})
	run("fleet", func(ctx context.Context) error { return src.Run(ctx, store) })

	var act server.Actioner
	if tok := readSecret(*ghToken); tok != "" {
		gh := signals.NewGitHub(signals.GitHubOptions{Token: tok, Repo: *repo, AuditBranchPrefix: *auditPfx})
		run("github", func(ctx context.Context) error { return gh.Run(ctx, store, resolve) })
		act = actions.New(actions.Options{Token: tok, Repo: *repo, Branch: *branch, BaselineTag: *baseline, AuditBranchPrefix: *auditPfx})
	} else {
		slog.Warn("no GitHub token: no PR signals, no buttons")
	}
	if tok := readSecret(*slackToken); tok != "" {
		sl := signals.NewSlack(signals.SlackOptions{Token: tok, Channel: *channel})
		run("slack", func(ctx context.Context) error { return sl.Run(ctx, store, resolve) })
	} else {
		slog.Warn("no Slack token: no alert or triage signals")
	}

	var webFS fs.FS = web.FS()
	if *webDir != "" {
		webFS = os.DirFS(*webDir)
	}
	handler := server.New(server.Options{
		Store:          store,
		Web:            webFS,
		Auth:           auth,
		Writers:        splitList(*writers),
		Actions:        act,
		AllowedOrigins: splitList(*origins),
	})
	srv := &http.Server{Addr: *addr, Handler: handler, ReadHeaderTimeout: readHeaderTimeout}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	slog.Info("fleet-scope listening", "addr", *addr, "project", *project)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fatal("serve", err)
	}
}

func fatal(what string, err error) {
	slog.Error(what, "err", err)
	os.Exit(1)
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// readSecret returns a file's trimmed contents, or "" when path is empty or
// unreadable (logged).
func readSecret(path string) string {
	if path == "" {
		return ""
	}
	b, err := os.ReadFile(path)
	if err != nil {
		slog.Warn("cannot read secret file", "path", path, "err", err)
		return ""
	}
	return strings.TrimSpace(string(b))
}

func splitList(v string) []string {
	var out []string
	for _, s := range strings.Split(v, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func parseLinks(v string) []model.Link {
	var out []model.Link
	for _, kv := range splitList(v) {
		if name, url, ok := strings.Cut(kv, "="); ok {
			out = append(out, model.Link{Name: name, URL: url})
		}
	}
	return out
}
