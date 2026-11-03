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

//go:build live

// Live check, read-only: runs both pollers against the real channel and repo
// and prints the events as JSON lines.
//
//	SIGNALS_SLACK_TOKEN=$(cat ~/.kcna26/slack-bot-token) SIGNALS_GITHUB_TOKEN=$(gh auth token) \
//	  go test -tags live -run TestLive -v ./internal/signals/
package signals

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/model"
)

type printer struct{ mu sync.Mutex }

func (p *printer) Emit(evs ...model.Event) []model.Event {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, e := range evs {
		b, _ := json.Marshal(e)
		fmt.Println(string(b))
	}
	return evs
}

func TestLive(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	p := &printer{}
	var wg sync.WaitGroup
	if tok := os.Getenv("SIGNALS_SLACK_TOKEN"); tok != "" {
		s := NewSlack(SlackOptions{Token: tok, Channel: "C0CEZ07K39N"})
		s.lookback = 12 * time.Hour
		wg.Go(func() { _ = s.Run(ctx, p, resolveAll) })
	}
	if tok := os.Getenv("SIGNALS_GITHUB_TOKEN"); tok != "" {
		g := NewGitHub(GitHubOptions{Token: tok, Repo: "gke-demos/kcna26-fleet-gitops", AuditBranchPrefix: "platform-agent/fix-"})
		wg.Go(func() { _ = g.Run(ctx, p, resolveAll) })
	}
	wg.Wait()
}
