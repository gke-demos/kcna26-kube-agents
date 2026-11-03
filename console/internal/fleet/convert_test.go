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

package fleet

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/collector"
	"github.com/gke-demos/kcna26-kube-agents/console/internal/model"
)

func TestExcluded(t *testing.T) {
	o := New(Options{}).o
	for ns, want := range map[string]bool{
		"kube-system":                  true,
		"kube-node-lease":              true,
		"gke-managed-cim":              true,
		"gke-gmp-system":               true,
		"gke-anything":                 true,
		"gmp-public":                   true,
		"config-management-system":     true,
		"config-management-monitoring": true,
		"cert-manager":                 true,
		"boutique":                     false,
		"default":                      false,
		"kube-systemd":                 false,
		"gke":                          false,
	} {
		if got := excluded(o.Exclude, ns); got != want {
			t.Errorf("excluded(%q) = %v, want %v", ns, got, want)
		}
	}
}

func TestDrawn(t *testing.T) {
	o := New(Options{}).o
	cases := []struct {
		cluster, ns string
		want        bool
	}{
		{"kube-agents-hub", "kubeagents-system", true},
		{"kube-agents-hub", "default", false},
		{"kube-agents-hub", "boutique", false},
		{"boutique-prod", "boutique", true},
		{"boutique-prod", "kubeagents-system", true},
		{"boutique-prod", "kube-system", false},
		{"boutique-prod", "gke-managed-system", false},
	}
	for _, c := range cases {
		if got := drawn(o, c.cluster, c.ns); got != c.want {
			t.Errorf("drawn(%s, %s) = %v, want %v", c.cluster, c.ns, got, c.want)
		}
	}
}

func TestClusterAgents(t *testing.T) {
	o := New(Options{}).o
	web := *deployment("web", 1, 1, 1)
	sys := *deployment("kube-dns", 1, 1, 1)
	sys.Namespace = "kube-system"
	dup := *deployment("web", 1, 1, 1)
	dup.Namespace = "staging"
	agents := clusterAgents(o, "boutique-prod", []appsv1.Deployment{web, sys, dup}, nil,
		[]corev1.Pod{pod("web", "web-6d4f-aaaaa", readyStatus())}, now)
	var names []string
	for _, a := range agents {
		names = append(names, a.Name)
	}
	if want := []string{"boutique.web", "staging.web"}; !slices.Equal(names, want) {
		t.Fatalf("names %v, want %v", names, want)
	}
	a := agents[0]
	if a.Atespace != "boutique-prod" || a.Namespace != "boutique" || a.Kind != kindDeployment || a.State != model.StateRunning ||
		a.Replicas != 1 || a.Ready != 1 || a.Image != "gcr.io/demo/web:v1" || a.MemoryLimit != "20Mi" || a.UID != "uid-web" {
		t.Fatalf("agent %+v", a)
	}
	if a.Worker != "cluster-agent-boutique-prod" || a.WorkerPool != workerPool || a.WorkerNode != "kube-agents-hub" {
		t.Fatalf("worker fields %q %q %q", a.Worker, a.WorkerPool, a.WorkerNode)
	}
}

func TestBuildWorkers(t *testing.T) {
	actors := map[string][]model.Agent{
		"boutique-prod":   {{Atespace: "boutique-prod", Name: "cart"}, {Atespace: "boutique-prod", Name: "web"}},
		"bank-prod":       {{Atespace: "bank-prod", Name: "ledger"}},
		"kube-agents-hub": nil,
	}
	ws := buildWorkers("kube-agents-hub", "kubeagents-system", []string{"bank-prod", "boutique-prod", "kube-agents-hub"}, actors)
	type row struct {
		name   string
		n      int32
		actors []string
	}
	want := []row{
		{"planning-agent", 3, nil},
		{"platform-agent", 3, nil},
		{"cluster-agent-bank-prod", 1, []string{"bank-prod/ledger"}},
		{"cluster-agent-boutique-prod", 2, []string{"boutique-prod/cart", "boutique-prod/web"}},
		{"cluster-agent-kube-agents-hub", 0, nil},
	}
	if len(ws) != len(want) {
		t.Fatalf("%d workers, want %d", len(ws), len(want))
	}
	for i, w := range ws {
		r := want[i]
		if w.Name != r.name || w.CapacityActors != r.n || w.AllocatedActors != r.n || !slices.Equal(w.Actors, r.actors) {
			t.Errorf("worker %d: %+v, want %+v", i, w, r)
		}
		if w.Pool != "kube-agents" || w.Node != "kube-agents-hub" || w.State != "ACTIVE" {
			t.Errorf("worker %s: pool %q node %q state %q", w.Name, w.Pool, w.Node, w.State)
		}
	}
}

type recorder struct{ updates []collector.Update }

func (r *recorder) Apply(u collector.Update) { r.updates = append(r.updates, u) }

// TestCycleKeepsLastGoodOnError checks that a failing cluster reports its
// error, keeps its last workloads, and doesn't stop the others; and that a
// cluster gone from the GKE list is dropped.
func TestCycleKeepsLastGoodOnError(t *testing.T) {
	boutique := fake.NewClientset(deployment("web", 1, 1, 1))
	bank := fake.NewClientset(deployment("ledger", 1, 1, 1))
	failing := false
	bank.PrependReactor("list", "*", func(k8stesting.Action) (bool, runtime.Object, error) {
		if failing {
			return true, nil, errors.New("unreachable")
		}
		return false, nil, nil
	})
	clusters := []gkeCluster{{Name: "boutique-prod", Endpoint: "1.2.3.4", Status: "RUNNING"}, {Name: "bank-prod", Endpoint: "5.6.7.8", Status: "RUNNING"}}
	rec := &recorder{}
	p := &poller{
		o:    New(Options{}).o,
		sink: rec,
		list: func(context.Context) ([]gkeCluster, error) { return slices.Clone(clusters), nil },
		connect: func(c gkeCluster) (kubernetes.Interface, error) {
			if c.Name == "bank-prod" {
				return bank, nil
			}
			return boutique, nil
		},
		states: map[string]*clusterState{},
	}
	picture := func() collector.Update {
		for i := len(rec.updates) - 1; i >= 0; i-- {
			if rec.updates[i].Atespaces != nil {
				return rec.updates[i]
			}
		}
		t.Fatal("no picture")
		return collector.Update{}
	}
	pollerErr := func(name string) error {
		for i := len(rec.updates) - 1; i >= 0; i-- {
			if rec.updates[i].Poller == name {
				return rec.updates[i].Err
			}
		}
		t.Fatalf("no status for %s", name)
		return nil
	}

	p.cycle(t.Context())
	u := picture()
	if len(u.Atespaces) != 2 || len(u.Actors["bank-prod"]) != 1 || len(u.Actors["boutique-prod"]) != 1 || len(u.Workers) != 4 {
		t.Fatalf("first picture %+v", u)
	}

	failing = true
	p.cycle(t.Context())
	if pollerErr("fleet/bank-prod") == nil || pollerErr("fleet/boutique-prod") != nil {
		t.Fatalf("statuses: bank %v, boutique %v", pollerErr("fleet/bank-prod"), pollerErr("fleet/boutique-prod"))
	}
	if u := picture(); len(u.Actors["bank-prod"]) != 1 {
		t.Fatalf("bank's last good workloads dropped: %+v", u.Actors)
	}

	clusters = clusters[:1]
	p.listed = time.Time{}
	p.cycle(t.Context())
	if u := picture(); len(u.Atespaces) != 1 || u.Atespaces[0].Name != "boutique-prod" || len(u.Actors) != 1 {
		t.Fatalf("bank not dropped: %+v", u)
	}
}
