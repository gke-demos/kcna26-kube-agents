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

// Package fleet is the collector source for the demo fleet: every GKE cluster
// in a project as a district (atespace), every Deployment and StatefulSet as
// an "agent" whose state is its health, and kube-agents' own agents as the
// worker deck. It polls the GKE API for clusters and each cluster's API
// server for workloads and pods, read-only, with one Google token.
package fleet

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	"golang.org/x/sync/errgroup"
	container "google.golang.org/api/container/v1"
	"google.golang.org/api/option"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/collector"
	"github.com/gke-demos/kcna26-kube-agents/console/internal/model"
)

const (
	sourceName            = "fleet"
	defaultHub            = "kube-agents-hub"
	defaultAgentNamespace = "kubeagents-system"
	defaultInterval       = 3 * time.Second
	defaultClusterRefresh = 60 * time.Second

	// Poller names for health reporting.
	gkePoller           = "fleet/gke"
	clusterPollerPrefix = "fleet/"

	// clustersParent lists clusters in every location of a project.
	clustersParent = "projects/%s/locations/-"
	// clusterListTimeout bounds one GKE cluster list.
	clusterListTimeout = 20 * time.Second
	// clusterPollTimeout bounds one cluster's workload poll, so an
	// unreachable cluster delays a cycle by at most this much.
	clusterPollTimeout = 10 * time.Second

	// Cluster statuses whose API server cannot be reached.
	statusProvisioning = "PROVISIONING"
	statusStopping     = "STOPPING"

	endpointScheme = "https://"
	userAgent      = "fleet-scope"
	clientQPS      = 20
	clientBurst    = 40
)

// defaultExclude are the system namespaces never drawn.
var defaultExclude = []string{
	"kube-system", "kube-public", "kube-node-lease",
	"gke-managed-*", "gke-gmp-system", "gmp-system", "gmp-public",
	"config-management-system", "config-management-monitoring",
	"resource-group-system", "cert-manager", "gke-*",
}

// Options configures the source.
type Options struct {
	// Project whose clusters are drawn.
	Project string
	// Hub is the cluster kube-agents runs on; AgentNamespace its namespace
	// there. On the hub only AgentNamespace's workloads are drawn.
	Hub            string
	AgentNamespace string
	// Interval between workload polls (default 3s); ClusterRefresh between
	// cluster list refreshes (default 60s).
	Interval       time.Duration
	ClusterRefresh time.Duration
	// Exclude are namespaces never drawn (defaults: system namespaces). A
	// trailing "*" matches a prefix ("gke-*").
	Exclude []string
	// TokenSource authenticates to GKE and the clusters; nil uses ADC.
	TokenSource oauth2.TokenSource
}

// Source polls the fleet.
type Source struct{ o Options }

// New returns a source.
func New(o Options) *Source {
	if o.Hub == "" {
		o.Hub = defaultHub
	}
	if o.AgentNamespace == "" {
		o.AgentNamespace = defaultAgentNamespace
	}
	if o.Interval <= 0 {
		o.Interval = defaultInterval
	}
	if o.ClusterRefresh <= 0 {
		o.ClusterRefresh = defaultClusterRefresh
	}
	if o.Exclude == nil {
		o.Exclude = defaultExclude
	}
	return &Source{o: o}
}

// Name implements collector.Source.
func (s *Source) Name() string { return sourceName }

// Run implements collector.Source.
func (s *Source) Run(ctx context.Context, sink collector.Sink) error {
	ts := s.o.TokenSource
	if ts == nil {
		var err error
		if ts, err = google.DefaultTokenSource(ctx, container.CloudPlatformScope); err != nil {
			sink.Apply(collector.Update{Poller: gkePoller, Err: err})
			return fmt.Errorf("fleet: credentials: %w", err)
		}
	}
	ts = oauth2.ReuseTokenSource(nil, ts)
	svc, err := container.NewService(ctx, option.WithTokenSource(ts))
	if err != nil {
		sink.Apply(collector.Update{Poller: gkePoller, Err: err})
		return fmt.Errorf("fleet: GKE client: %w", err)
	}
	p := &poller{
		o:       s.o,
		sink:    sink,
		list:    func(ctx context.Context) ([]gkeCluster, error) { return listClusters(ctx, svc, s.o.Project) },
		connect: func(c gkeCluster) (kubernetes.Interface, error) { return connect(c, ts) },
		states:  map[string]*clusterState{},
	}
	return p.run(ctx)
}

// gkeCluster is what the source needs from a GKE cluster.
type gkeCluster struct {
	Name     string
	Location string
	Status   string
	// Endpoint is the API server's host; CA its base64 CA bundle, empty
	// when the host has a publicly trusted certificate (DNS endpoint).
	Endpoint string
	CA       string
	Created  *time.Time
}

// clusterState is a cluster's client and its last good workload list.
type clusterState struct {
	cluster gkeCluster
	client  kubernetes.Interface
	err     error // from connect
	agents  []model.Agent
}

// poller runs the polling loop. list and connect are swapped out in tests.
type poller struct {
	o       Options
	sink    collector.Sink
	list    func(context.Context) ([]gkeCluster, error)
	connect func(gkeCluster) (kubernetes.Interface, error)

	clusters []gkeCluster // latest good list, sorted by name; nil until one
	listed   time.Time
	states   map[string]*clusterState
}

func (p *poller) run(ctx context.Context) error {
	t := time.NewTicker(p.o.Interval)
	defer t.Stop()
	for {
		p.cycle(ctx)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

// cycle refreshes the cluster list when due, polls every cluster in parallel
// and pushes the whole picture as one update.
func (p *poller) cycle(ctx context.Context) {
	if p.clusters == nil || time.Since(p.listed) >= p.o.ClusterRefresh {
		lctx, cancel := context.WithTimeout(ctx, clusterListTimeout)
		cs, err := p.list(lctx)
		cancel()
		if ctx.Err() != nil {
			return
		}
		p.sink.Apply(collector.Update{Poller: gkePoller, Err: err})
		if err == nil {
			p.setClusters(cs)
		}
	}
	if p.clusters == nil {
		return
	}

	errs := make([]error, len(p.clusters))
	var g errgroup.Group
	for i, c := range p.clusters {
		st := p.states[c.Name]
		g.Go(func() error {
			cctx, cancel := context.WithTimeout(ctx, clusterPollTimeout)
			defer cancel()
			agents, err := p.poll(cctx, st)
			if err == nil {
				st.agents = agents
			}
			errs[i] = err
			return nil
		})
	}
	_ = g.Wait()
	if ctx.Err() != nil {
		return
	}

	names := make([]string, len(p.clusters))
	atespaces := make([]model.Atespace, len(p.clusters))
	actors := make(map[string][]model.Agent, len(p.clusters))
	for i, c := range p.clusters {
		names[i] = c.Name
		atespaces[i] = model.Atespace{Name: c.Name, CreateTime: c.Created}
		actors[c.Name] = p.states[c.Name].agents
	}
	p.sink.Apply(collector.Update{
		Atespaces: atespaces,
		Actors:    actors,
		Workers:   buildWorkers(p.o.Hub, p.o.AgentNamespace, names, actors),
	})
	for i, c := range p.clusters {
		p.sink.Apply(collector.Update{Poller: clusterPollerPrefix + c.Name, Err: errs[i]})
	}
}

// setClusters installs a fresh cluster list, reconnecting clusters whose
// endpoint changed and forgetting the ones that are gone. A cluster's last
// good workloads survive a reconnect.
func (p *poller) setClusters(cs []gkeCluster) {
	slices.SortFunc(cs, func(a, b gkeCluster) int { return strings.Compare(a.Name, b.Name) })
	cs = slices.CompactFunc(cs, func(a, b gkeCluster) bool { return a.Name == b.Name })
	next := make(map[string]*clusterState, len(cs))
	for _, c := range cs {
		st := p.states[c.Name]
		if st == nil {
			st = &clusterState{}
		}
		if st.client == nil || st.cluster.Endpoint != c.Endpoint || st.cluster.CA != c.CA {
			st.client, st.err = nil, nil
			if pollable(c) {
				st.client, st.err = p.connect(c)
			}
		}
		st.cluster = c
		next[c.Name] = st
	}
	p.states = next
	p.clusters = cs
	p.listed = time.Now()
}

// poll lists one cluster's workloads and pods and maps them to agents.
func (p *poller) poll(ctx context.Context, st *clusterState) ([]model.Agent, error) {
	c := st.cluster
	switch {
	case !pollable(c):
		return nil, fmt.Errorf("cluster is %s", c.Status)
	case st.err != nil:
		return nil, st.err
	}
	ns := metav1.NamespaceAll
	if c.Name == p.o.Hub {
		ns = p.o.AgentNamespace
	}
	var (
		deps []appsv1.Deployment
		sets []appsv1.StatefulSet
		pods []corev1.Pod
	)
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		l, err := st.client.AppsV1().Deployments(ns).List(gctx, metav1.ListOptions{})
		if err != nil {
			return fmt.Errorf("list deployments: %w", err)
		}
		deps = l.Items
		return nil
	})
	g.Go(func() error {
		l, err := st.client.AppsV1().StatefulSets(ns).List(gctx, metav1.ListOptions{})
		if err != nil {
			return fmt.Errorf("list statefulsets: %w", err)
		}
		sets = l.Items
		return nil
	})
	g.Go(func() error {
		l, err := st.client.CoreV1().Pods(ns).List(gctx, metav1.ListOptions{})
		if err != nil {
			return fmt.Errorf("list pods: %w", err)
		}
		pods = l.Items
		return nil
	})
	if err := g.Wait(); err != nil {
		return nil, err
	}
	return clusterAgents(p.o, c.Name, deps, sets, pods, time.Now()), nil
}

// pollable reports whether a cluster's API server can be asked anything.
func pollable(c gkeCluster) bool {
	return c.Endpoint != "" && c.Status != statusProvisioning && c.Status != statusStopping
}

// listClusters returns every cluster in the project.
func listClusters(ctx context.Context, svc *container.Service, project string) ([]gkeCluster, error) {
	resp, err := svc.Projects.Locations.Clusters.List(fmt.Sprintf(clustersParent, project)).Context(ctx).Do()
	if err != nil {
		return nil, fmt.Errorf("list clusters: %w", err)
	}
	if len(resp.MissingZones) > 0 {
		return nil, fmt.Errorf("list clusters: zones unavailable: %s", strings.Join(resp.MissingZones, ", "))
	}
	out := make([]gkeCluster, 0, len(resp.Clusters))
	for _, c := range resp.Clusters {
		out = append(out, toCluster(c))
	}
	return out, nil
}

func toCluster(c *container.Cluster) gkeCluster {
	g := gkeCluster{Name: c.Name, Location: c.Location, Status: c.Status, Endpoint: c.Endpoint}
	if c.MasterAuth != nil {
		g.CA = c.MasterAuth.ClusterCaCertificate
	}
	if g.Endpoint == "" && c.ControlPlaneEndpointsConfig != nil {
		if d := c.ControlPlaneEndpointsConfig.DnsEndpointConfig; d != nil && d.AllowExternalTraffic {
			g.Endpoint, g.CA = d.Endpoint, ""
		}
	}
	if t, err := time.Parse(time.RFC3339, c.CreateTime); err == nil {
		g.Created = &t
	}
	return g
}

// connect builds a clientset for a cluster that authenticates with the
// Google token (GKE accepts it; roles/container.viewer grants read).
func connect(c gkeCluster, ts oauth2.TokenSource) (kubernetes.Interface, error) {
	cfg := &rest.Config{
		Host:      endpointScheme + c.Endpoint,
		UserAgent: userAgent,
		QPS:       clientQPS,
		Burst:     clientBurst,
		WrapTransport: func(rt http.RoundTripper) http.RoundTripper {
			return &oauth2.Transport{Source: ts, Base: rt}
		},
	}
	if c.CA != "" {
		ca, err := base64.StdEncoding.DecodeString(c.CA)
		if err != nil {
			return nil, fmt.Errorf("cluster CA: %w", err)
		}
		cfg.CAData = ca
	}
	return kubernetes.NewForConfig(cfg)
}
