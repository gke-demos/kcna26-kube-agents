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

// Package server serves fleet-scope's HTTP API and the embedded front end.
//
//	GET  /healthz                       unauthenticated (the load balancer's health check)
//	GET  /api/snapshot                  the whole picture
//	GET  /api/stream                    WebSocket: snapshot, then event batches
//	GET  /api/agents/{cluster}/{name}   a workload, for the side panel
//	GET  /api/actions                   the buttons the caller may press
//	POST /api/actions/{name}            press one (writers only)
//
// Every route but /healthz needs an identity (IAP's signed header, verified).
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"slices"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/collector"
	"github.com/gke-demos/kcna26-kube-agents/console/internal/model"
)

const (
	// ActionHeader must be on every POST /api/actions call: a cross-site form
	// cannot set it, so it stops CSRF alongside the same-origin check.
	ActionHeader = "X-Fleet-Scope"
	// ActionTimeout bounds one button press (a few GitHub API calls).
	ActionTimeout   = 60 * time.Second
	defaultPing     = 20 * time.Second
	writeTimeout    = 10 * time.Second
	maxActionParams = 1 << 12
)

// Identifier names the caller, or fails when the request carries no valid
// identity.
type Identifier interface {
	Identify(r *http.Request) (string, error)
}

// ActionSpec describes one button.
type ActionSpec struct {
	Name  string `json:"name"`
	Title string `json:"title"`
	// Targets the action can be aimed at ("recommendationservice", ...);
	// empty for actions that take none (reset).
	Targets []string `json:"targets,omitempty"`
}

// Actioner runs the buttons.
type Actioner interface {
	Actions() []ActionSpec
	// Run performs action on target (may be empty) on behalf of by. It
	// returns a one-line result and a link (a commit, say) for the feed.
	Run(ctx context.Context, action, target, by string) (title, link string, err error)
}

// Options configures the server.
type Options struct {
	Store *collector.Store
	// Web is the front end; nil serves no UI.
	Web fs.FS
	// Auth identifies callers. Required.
	Auth Identifier
	// Writers may press buttons: emails, or "domain:example.com".
	Writers []string
	// Actions runs the buttons; nil disables them.
	Actions Actioner
	// AllowedOrigins are extra host patterns (path.Match syntax) whose pages
	// may open the stream and post actions; same-origin is always allowed.
	AllowedOrigins []string
	PingInterval   time.Duration
}

// Server is the HTTP handler.
type Server struct {
	o   Options
	mux *http.ServeMux
}

// New builds the handler.
func New(o Options) *Server {
	if o.PingInterval <= 0 {
		o.PingInterval = defaultPing
	}
	s := &Server{o: o, mux: http.NewServeMux()}
	s.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok\n")) })
	s.mux.Handle("GET /api/snapshot", s.authed(s.snapshot))
	s.mux.Handle("GET /api/stream", s.authed(s.stream))
	s.mux.Handle("GET /api/agents/{cluster}/{name}", s.authed(s.agent))
	s.mux.Handle("GET /api/actions", s.authed(s.listActions))
	s.mux.Handle("POST /api/actions/{name}", s.authed(s.runAction))
	if o.Web != nil {
		files := http.FileServerFS(o.Web)
		s.mux.Handle("/", s.authed(func(w http.ResponseWriter, r *http.Request, _ string) { files.ServeHTTP(w, r) }))
	}
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	s.mux.ServeHTTP(w, r)
}

type authedHandler func(w http.ResponseWriter, r *http.Request, who string)

// authed rejects requests without a valid identity.
func (s *Server) authed(h authedHandler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		who, err := s.o.Auth.Identify(r)
		if err != nil {
			slog.Info("refused unauthenticated request", "path", r.URL.Path, "err", err)
			http.Error(w, "unauthenticated", http.StatusUnauthorized)
			return
		}
		h(w, r, who)
	})
}

// IsWriter reports whether who may press buttons.
func (s *Server) IsWriter(who string) bool {
	who = strings.ToLower(who)
	for _, w := range s.o.Writers {
		w = strings.ToLower(strings.TrimSpace(w))
		if d, ok := strings.CutPrefix(w, "domain:"); ok {
			if strings.HasSuffix(who, "@"+d) {
				return true
			}
		} else if w == who {
			return true
		}
	}
	return false
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// snapshotFor is the store's snapshot with the caller's own feature flags.
func (s *Server) snapshotFor(snap model.Snapshot, who string) model.Snapshot {
	snap.Features.Actions = s.o.Actions != nil && s.IsWriter(who)
	return snap
}

func (s *Server) snapshot(w http.ResponseWriter, _ *http.Request, who string) {
	writeJSON(w, http.StatusOK, s.snapshotFor(s.o.Store.Snapshot(), who))
}

func (s *Server) agent(w http.ResponseWriter, r *http.Request, _ string) {
	a, ok := s.o.Store.Agent(r.PathValue("cluster"), r.PathValue("name"))
	if !ok {
		http.Error(w, "no such workload", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"agent": a})
}

// StreamMessage is one WebSocket message.
type StreamMessage struct {
	// Type is "snapshot" or "events".
	Type     string          `json:"type"`
	Snapshot *model.Snapshot `json:"snapshot,omitempty"`
	Events   []model.Event   `json:"events,omitempty"`
	// Resync is set on a snapshot sent because the client fell behind.
	Resync bool `json:"resync,omitempty"`
}

func (s *Server) stream(w http.ResponseWriter, r *http.Request, who string) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: s.o.AllowedOrigins})
	if err != nil {
		return
	}
	defer c.CloseNow()
	ctx := c.CloseRead(r.Context())

	send := func(m StreamMessage) error {
		b, err := json.Marshal(m)
		if err != nil {
			return err
		}
		wctx, cancel := context.WithTimeout(ctx, writeTimeout)
		defer cancel()
		return c.Write(wctx, websocket.MessageText, b)
	}

	ping := time.NewTicker(s.o.PingInterval)
	defer ping.Stop()
	resync := false
	for {
		snap, sub := s.o.Store.Subscribe()
		snap = s.snapshotFor(snap, who)
		if err := send(StreamMessage{Type: "snapshot", Snapshot: &snap, Resync: resync}); err != nil {
			sub.Cancel()
			return
		}
	events:
		for {
			select {
			case <-ctx.Done():
				sub.Cancel()
				c.Close(websocket.StatusNormalClosure, "")
				return
			case <-ping.C:
				pctx, cancel := context.WithTimeout(ctx, writeTimeout)
				err := c.Ping(pctx)
				cancel()
				if err != nil {
					sub.Cancel()
					return
				}
			case evs, ok := <-sub.C:
				if !ok {
					if sub.Lagged() {
						slog.Info("stream client fell behind; resyncing", "remote", r.RemoteAddr)
						resync = true
						break events
					}
					return
				}
				if err := send(StreamMessage{Type: "events", Events: evs}); err != nil {
					sub.Cancel()
					return
				}
			}
		}
	}
}

func (s *Server) listActions(w http.ResponseWriter, _ *http.Request, who string) {
	if s.o.Actions == nil || !s.IsWriter(who) {
		writeJSON(w, http.StatusOK, []ActionSpec{})
		return
	}
	writeJSON(w, http.StatusOK, s.o.Actions.Actions())
}

type actionRequest struct {
	Target string `json:"target"`
}

func (s *Server) runAction(w http.ResponseWriter, r *http.Request, who string) {
	if s.o.Actions == nil {
		http.Error(w, "actions are disabled", http.StatusNotFound)
		return
	}
	if !s.IsWriter(who) {
		http.Error(w, "not on the writers list", http.StatusForbidden)
		return
	}
	if r.Header.Get(ActionHeader) == "" || !s.sameOrigin(r) {
		http.Error(w, "cross-site request refused", http.StatusForbidden)
		return
	}
	name := r.PathValue("name")
	if !slices.ContainsFunc(s.o.Actions.Actions(), func(a ActionSpec) bool { return a.Name == name }) {
		http.Error(w, "no such action", http.StatusNotFound)
		return
	}
	var req actionRequest
	if r.ContentLength != 0 {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxActionParams)).Decode(&req); err != nil {
			http.Error(w, "bad request body", http.StatusBadRequest)
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), ActionTimeout)
	defer cancel()
	title, link, err := s.o.Actions.Run(ctx, name, req.Target, who)
	ev := model.Event{Type: model.EventAction, Title: title, Link: link, Actor: who, Reason: name}
	if err != nil {
		slog.Warn("action failed", "action", name, "target", req.Target, "by", who, "err", err)
		ev.Title = name + " failed: " + err.Error()
		ev.Message = "failed"
		s.o.Store.Emit(ev)
		code := http.StatusBadGateway
		if errors.Is(err, context.DeadlineExceeded) {
			code = http.StatusGatewayTimeout
		}
		http.Error(w, ev.Title, code)
		return
	}
	slog.Info("action", "action", name, "target", req.Target, "by", who, "result", title)
	s.o.Store.Emit(ev)
	writeJSON(w, http.StatusOK, map[string]string{"title": title, "link": link})
}

// sameOrigin requires a browser POST to come from this host or an allowed one.
func (s *Server) sameOrigin(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return true
	}
	u, err := url.Parse(o)
	if err != nil || u.Host == "" {
		return false
	}
	if strings.EqualFold(u.Host, r.Host) {
		return true
	}
	for _, p := range s.o.AllowedOrigins {
		if ok, _ := path.Match(strings.ToLower(p), strings.ToLower(u.Host)); ok {
			return true
		}
	}
	return false
}
