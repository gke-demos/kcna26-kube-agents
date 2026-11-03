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
// over the GitHub REST API (the image has no git). STUB: interface fixed,
// body to come.
package actions

import (
	"context"
	"errors"
	"net/http"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/server"
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
type Runner struct{ o Options }

// New returns a runner.
func New(o Options) *Runner { return &Runner{o: o} }

// Actions implements server.Actioner.
func (r *Runner) Actions() []server.ActionSpec { return nil }

// Run implements server.Actioner.
func (r *Runner) Run(ctx context.Context, action, target, by string) (string, string, error) {
	return "", "", errors.New("not implemented")
}
