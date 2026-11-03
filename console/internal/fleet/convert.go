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
	"slices"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/model"
)

const (
	kindDeployment  = "Deployment"
	kindStatefulSet = "StatefulSet"
	// defaultReplicas is what Kubernetes assumes when spec.replicas is unset.
	defaultReplicas int32 = 1

	// The worker deck: kube-agents' own agents.
	workerPool         = "kube-agents"
	planningAgent      = "planning-agent"
	platformAgent      = "platform-agent"
	clusterAgentPrefix = "cluster-agent-"
	// workerActive is the worker state the front end draws as normal (any
	// other state gets a badge; "DRAINING" is styled).
	workerActive = "ACTIVE"

	// excludeWildcard ends an Exclude pattern that matches a prefix.
	excludeWildcard = "*"
	// nameSep joins a namespace (and kind) onto a workload name that is not
	// unique in its cluster; agent names cannot hold "/".
	nameSep = "."
)

// fromDeployment extracts what the scene needs from a Deployment.
func fromDeployment(d *appsv1.Deployment) workload {
	w := workload{
		Kind:               kindDeployment,
		Namespace:          d.Namespace,
		Name:               d.Name,
		UID:                string(d.UID),
		Selector:           selector(d.Spec.Selector),
		Replicas:           replicas(d.Spec.Replicas),
		Ready:              d.Status.ReadyReplicas,
		Updated:            d.Status.UpdatedReplicas,
		CheckUpdated:       true,
		Generation:         d.Generation,
		ObservedGeneration: d.Status.ObservedGeneration,
		Template:           d.Spec.Template.Spec,
		Created:            d.CreationTimestamp.Time,
	}
	w.Changed = latest(d.ObjectMeta)
	for _, c := range d.Status.Conditions {
		w.Changed = later(w.Changed, c.LastUpdateTime.Time, c.LastTransitionTime.Time)
	}
	return w
}

// fromStatefulSet extracts what the scene needs from a StatefulSet.
func fromStatefulSet(s *appsv1.StatefulSet) workload {
	w := workload{
		Kind:               kindStatefulSet,
		Namespace:          s.Namespace,
		Name:               s.Name,
		UID:                string(s.UID),
		Selector:           selector(s.Spec.Selector),
		Replicas:           replicas(s.Spec.Replicas),
		Ready:              s.Status.ReadyReplicas,
		Updated:            s.Status.UpdatedReplicas,
		CheckUpdated:       s.Spec.UpdateStrategy.Type != appsv1.OnDeleteStatefulSetStrategyType,
		Generation:         s.Generation,
		ObservedGeneration: s.Status.ObservedGeneration,
		Template:           s.Spec.Template.Spec,
		Created:            s.CreationTimestamp.Time,
	}
	w.Changed = latest(s.ObjectMeta)
	for _, c := range s.Status.Conditions {
		w.Changed = later(w.Changed, c.LastTransitionTime.Time)
	}
	return w
}

func selector(ls *metav1.LabelSelector) labels.Selector {
	if ls == nil {
		return nil
	}
	sel, err := metav1.LabelSelectorAsSelector(ls)
	if err != nil {
		return nil
	}
	return sel
}

func replicas(r *int32) int32 {
	if r == nil {
		return defaultReplicas
	}
	return *r
}

// latest is the newest of an object's creation and managed-field write times.
func latest(m metav1.ObjectMeta) time.Time {
	t := m.CreationTimestamp.Time
	for _, f := range m.ManagedFields {
		if f.Time != nil {
			t = later(t, f.Time.Time)
		}
	}
	return t
}

func later(t time.Time, others ...time.Time) time.Time {
	for _, o := range others {
		if o.After(t) {
			t = o
		}
	}
	return t
}

// toAgent renders a workload and its health as a scene agent.
func toAgent(cluster, hub string, w workload, h health) model.Agent {
	a := model.Agent{
		Atespace:   cluster,
		Name:       w.Name,
		UID:        w.UID,
		State:      h.State,
		Worker:     clusterAgent(cluster),
		WorkerPool: workerPool,
		WorkerNode: hub,
		Crash:      h.Crash,
		Version:    w.Generation,
		Kind:       w.Kind,
		Namespace:  w.Namespace,
		Replicas:   w.Replicas,
		Ready:      w.Ready,
		Reason:     h.Reason,
	}
	if !w.Created.IsZero() {
		t := w.Created.UTC()
		a.CreateTime = &t
	}
	if !w.Changed.IsZero() {
		t := w.Changed.UTC()
		a.UpdateTime = &t
	}
	if len(w.Template.Containers) > 0 {
		c := w.Template.Containers[0]
		a.Image = c.Image
		if q, ok := c.Resources.Limits[corev1.ResourceMemory]; ok {
			a.MemoryLimit = q.String()
		}
	}
	return a
}

// clusterAgents turns one cluster's listings into its scene agents, sorted by
// name. Workloads in namespaces the source does not draw are skipped. A name
// that is not unique in the cluster is qualified as "namespace.name" (and
// ".kind" after that when still ambiguous).
func clusterAgents(o Options, cluster string, deps []appsv1.Deployment, sets []appsv1.StatefulSet, pods []corev1.Pod, now time.Time) []model.Agent {
	var ws []workload
	for i := range deps {
		if drawn(o, cluster, deps[i].Namespace) {
			ws = append(ws, fromDeployment(&deps[i]))
		}
	}
	for i := range sets {
		if drawn(o, cluster, sets[i].Namespace) {
			ws = append(ws, fromStatefulSet(&sets[i]))
		}
	}
	byNS := map[string][]corev1.Pod{}
	for _, p := range pods {
		byNS[p.Namespace] = append(byNS[p.Namespace], p)
	}

	names := uniqueNames(ws)
	out := make([]model.Agent, 0, len(ws))
	for i, w := range ws {
		a := toAgent(cluster, o.Hub, w, assess(w, podsFor(w, byNS[w.Namespace]), now))
		a.Name = names[i]
		out = append(out, a)
	}
	slices.SortFunc(out, func(a, b model.Agent) int { return strings.Compare(a.Name, b.Name) })
	return out
}

// uniqueNames returns an agent name per workload, unique in the list.
func uniqueNames(ws []workload) []string {
	count := func(f func(workload) string) map[string]int {
		m := map[string]int{}
		for _, w := range ws {
			m[f(w)]++
		}
		return m
	}
	byName := count(func(w workload) string { return w.Name })
	qualified := func(w workload) string { return w.Namespace + nameSep + w.Name }
	byQualified := count(qualified)
	out := make([]string, len(ws))
	for i, w := range ws {
		switch {
		case byName[w.Name] == 1:
			out[i] = w.Name
		case byQualified[qualified(w)] == 1:
			out[i] = qualified(w)
		default:
			out[i] = qualified(w) + nameSep + strings.ToLower(w.Kind)
		}
	}
	return out
}

// drawn reports whether a namespace's workloads are drawn: on the hub only
// the agent namespace, elsewhere everything not excluded.
func drawn(o Options, cluster, namespace string) bool {
	if cluster == o.Hub {
		return namespace == o.AgentNamespace
	}
	return !excluded(o.Exclude, namespace)
}

// excluded matches a namespace against patterns; a trailing "*" matches a
// prefix.
func excluded(patterns []string, namespace string) bool {
	for _, p := range patterns {
		if prefix, ok := strings.CutSuffix(p, excludeWildcard); ok {
			if strings.HasPrefix(namespace, prefix) {
				return true
			}
		} else if namespace == p {
			return true
		}
	}
	return false
}

func clusterAgent(cluster string) string { return clusterAgentPrefix + cluster }

// buildWorkers returns the worker deck: the planning and platform agents
// watching every workload, and a cluster agent per cluster watching that
// cluster's.
func buildWorkers(hub, namespace string, clusters []string, actors map[string][]model.Agent) []model.Worker {
	total := 0
	for _, c := range clusters {
		total += len(actors[c])
	}
	worker := func(name string, n int) model.Worker {
		return model.Worker{
			Name: name,
			// The pads take their titles from Pod.
			Pod:             name,
			Pool:            workerPool,
			Namespace:       namespace,
			Node:            hub,
			State:           workerActive,
			CapacityActors:  int32(n),
			AllocatedActors: int32(n),
		}
	}
	out := []model.Worker{worker(planningAgent, total), worker(platformAgent, total)}
	for _, c := range clusters {
		w := worker(clusterAgent(c), len(actors[c]))
		for _, a := range actors[c] {
			w.Actors = append(w.Actors, a.Key())
		}
		out = append(out, w)
	}
	return out
}
