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

package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/collector"
	"github.com/gke-demos/kcna26-kube-agents/console/internal/model"
)

// headerAuth identifies callers by a test header; no header, no identity.
type headerAuth struct{}

func (headerAuth) Identify(r *http.Request) (string, error) {
	if who := r.Header.Get("X-Test-User"); who != "" {
		return who, nil
	}
	return "", errors.New("no identity")
}

type fakeActions struct{ ran []string }

func (f *fakeActions) Actions() []ActionSpec {
	return []ActionSpec{{Name: "trigger-oom", Targets: []string{"recommendationservice"}}, {Name: "reset"}}
}

func (f *fakeActions) Run(_ context.Context, action, target, by string) (ActionResult, error) {
	f.ran = append(f.ran, action+"/"+target+"/"+by)
	return ActionResult{Title: "done", Link: "https://example.com/commit/abc123", Key: "c/" + target, Commit: "abc123"}, nil
}

func newTestServer() (*Server, *fakeActions, *collector.Store) {
	store := collector.NewStore(collector.Options{Cluster: "test"})
	act := &fakeActions{}
	s := New(Options{
		Store:   store,
		Auth:    headerAuth{},
		Writers: []string{"writer@example.com", "domain:staff.example.com"},
		Actions: act,
	})
	return s, act, store
}

func do(s *Server, method, path, user string, hdr map[string]string, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if user != "" {
		r.Header.Set("X-Test-User", user)
	}
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func TestHealthzNeedsNoIdentity(t *testing.T) {
	s, _, _ := newTestServer()
	if w := do(s, http.MethodGet, "/healthz", "", nil, ""); w.Code != http.StatusOK {
		t.Fatalf("healthz: %d", w.Code)
	}
}

func TestEverythingElseNeedsIdentity(t *testing.T) {
	s, _, _ := newTestServer()
	for _, p := range []string{"/api/snapshot", "/api/actions", "/api/agents/c/n"} {
		if w := do(s, http.MethodGet, p, "", nil, ""); w.Code != http.StatusUnauthorized {
			t.Errorf("%s without identity: %d, want 401", p, w.Code)
		}
	}
	if w := do(s, http.MethodPost, "/api/actions/reset", "", map[string]string{ActionHeader: "1"}, ""); w.Code != http.StatusUnauthorized {
		t.Errorf("action without identity: %d, want 401", w.Code)
	}
}

func TestSnapshotReportsActionsPerCaller(t *testing.T) {
	s, _, _ := newTestServer()
	for _, tc := range []struct {
		user string
		want bool
	}{{"writer@example.com", true}, {"WRITER@example.com", true}, {"a@staff.example.com", true}, {"viewer@example.com", false}} {
		w := do(s, http.MethodGet, "/api/snapshot", tc.user, nil, "")
		var snap model.Snapshot
		if err := json.Unmarshal(w.Body.Bytes(), &snap); err != nil {
			t.Fatal(err)
		}
		if snap.Features.Actions != tc.want {
			t.Errorf("%s: actions=%v, want %v", tc.user, snap.Features.Actions, tc.want)
		}
	}
}

func TestActionGuards(t *testing.T) {
	hdr := map[string]string{ActionHeader: "1"}
	tests := []struct {
		name, user, path string
		hdr              map[string]string
		want             int
	}{
		{"viewer refused", "viewer@example.com", "/api/actions/reset", hdr, http.StatusForbidden},
		{"no custom header", "writer@example.com", "/api/actions/reset", nil, http.StatusForbidden},
		{"cross-site origin", "writer@example.com", "/api/actions/reset", map[string]string{ActionHeader: "1", "Origin": "https://evil.example"}, http.StatusForbidden},
		{"unknown action", "writer@example.com", "/api/actions/rm-rf", hdr, http.StatusNotFound},
		{"writer ok", "writer@example.com", "/api/actions/reset", hdr, http.StatusOK},
		{"same origin ok", "writer@example.com", "/api/actions/reset", map[string]string{ActionHeader: "1", "Origin": "http://example.com"}, http.StatusOK},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s, act, _ := newTestServer()
			w := do(s, http.MethodPost, tc.path, tc.user, tc.hdr, "")
			if w.Code != tc.want {
				t.Fatalf("got %d (%s), want %d", w.Code, strings.TrimSpace(w.Body.String()), tc.want)
			}
			if ran := len(act.ran) > 0; ran != (tc.want == http.StatusOK) {
				t.Fatalf("action ran=%v for status %d", ran, w.Code)
			}
		})
	}
}

func TestActionEmitsSignalWithPresser(t *testing.T) {
	s, act, store := newTestServer()
	w := do(s, http.MethodPost, "/api/actions/trigger-oom", "writer@example.com",
		map[string]string{ActionHeader: "1"}, `{"target":"recommendationservice"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	if len(act.ran) != 1 || act.ran[0] != "trigger-oom/recommendationservice/writer@example.com" {
		t.Fatalf("ran %v", act.ran)
	}
	recent := store.Snapshot().Recent
	if len(recent) != 1 || recent[0].Type != model.EventAction || recent[0].Actor != "writer@example.com" || recent[0].Link == "" {
		t.Fatalf("recent %+v", recent)
	}
}
