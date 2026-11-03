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
	"fmt"
	"slices"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/labels"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/model"
)

// Pod and container reasons the state mapping reads or reports.
const (
	reasonOOMKilled        = "OOMKilled"
	reasonCrashLoop        = "CrashLoopBackOff"
	reasonErrImagePull     = "ErrImagePull"
	reasonImagePullBackOff = "ImagePullBackOff"
	reasonConfigError      = "CreateContainerConfigError"
	reasonUnschedulable    = "Unschedulable"
	reasonProgressing      = "Progressing"
)

const (
	// recentOOMWindow is how long a container's last OOMKill keeps its
	// workload CRASHED after the container came back.
	recentOOMWindow = 5 * time.Minute
	// podHashChars is how much of a pod's generated suffix a crash message
	// keeps ("recommendationservice-659fd…").
	podHashChars = 5
	ellipsis     = "…"
	// maxDetailLen bounds kubelet messages quoted in a crash message.
	maxDetailLen = 100
)

// failurePriority orders failure reasons, most telling first. ErrImagePull is
// reported as ImagePullBackOff: the kubelet alternates between the two, and
// the scene should not flicker with it.
var failurePriority = []string{reasonOOMKilled, reasonImagePullBackOff, reasonConfigError, reasonCrashLoop}

// workload is the part of a Deployment or StatefulSet the state mapping and
// the scene need.
type workload struct {
	Kind      string
	Namespace string
	Name      string
	UID       string
	// Selector matches the workload's pods; nil matches none.
	Selector labels.Selector
	// Replicas is spec.replicas (1 when unset); Ready and Updated are from
	// status.
	Replicas int32
	Ready    int32
	Updated  int32
	// CheckUpdated is false when Updated says nothing about a rollout (a
	// StatefulSet with the OnDelete strategy).
	CheckUpdated       bool
	Generation         int64
	ObservedGeneration int64
	Template           corev1.PodSpec
	Created            time.Time
	// Changed is the latest time the object or its status was written.
	Changed time.Time
}

// health is a workload's state in the scene's terms.
type health struct {
	State  string
	Reason string
	Crash  *model.Crash
}

// failure is one failing container.
type failure struct {
	reason string
	pod    string
	detail string
	at     *time.Time
}

// assess maps a workload and its pods (see podsFor) onto a scene state. A
// failing pod wins over every count, so a rollout whose new pod crashes is
// CRASHED while the old pod still serves.
func assess(w workload, pods []corev1.Pod, now time.Time) health {
	live := make([]corev1.Pod, 0, len(pods))
	for _, p := range pods {
		if p.DeletionTimestamp == nil {
			live = append(live, p)
		}
	}
	slices.SortFunc(live, func(a, b corev1.Pod) int { return strings.Compare(a.Name, b.Name) })

	if f, ok := worstFailure(live, now); ok {
		msg := shortPod(w.Name, f.pod) + " " + f.reason
		if f.detail != "" {
			msg += " (" + f.detail + ")"
		}
		return health{State: model.StateCrashed, Reason: f.reason, Crash: &model.Crash{Message: msg, Time: f.at}}
	}
	for i := range live {
		if unschedulable(&live[i]) {
			return health{State: model.StateUnspecified, Reason: reasonUnschedulable}
		}
	}
	switch {
	case w.Replicas == 0:
		return health{State: model.StateSuspended}
	case w.ObservedGeneration < w.Generation,
		w.CheckUpdated && w.Updated < w.Replicas,
		w.Ready < w.Replicas:
		return health{State: model.StateResuming, Reason: reasonProgressing}
	}
	return health{State: model.StateRunning}
}

// podsFor returns the pods in the workload's namespace its selector matches.
func podsFor(w workload, pods []corev1.Pod) []corev1.Pod {
	if w.Selector == nil || w.Selector.Empty() {
		return nil
	}
	var out []corev1.Pod
	for _, p := range pods {
		if p.Namespace == w.Namespace && w.Selector.Matches(labels.Set(p.Labels)) {
			out = append(out, p)
		}
	}
	return out
}

// worstFailure returns the most telling failing container across pods
// (sorted by name, so ties go to the first pod).
func worstFailure(pods []corev1.Pod, now time.Time) (failure, bool) {
	var best failure
	bestRank := len(failurePriority)
	for i := range pods {
		p := &pods[i]
		statuses := append(slices.Clone(p.Status.InitContainerStatuses), p.Status.ContainerStatuses...)
		for _, cs := range statuses {
			f, ok := containerFailure(p, cs, now)
			if !ok {
				continue
			}
			if r := slices.Index(failurePriority, f.reason); r < bestRank {
				best, bestRank = f, r
			}
		}
	}
	return best, bestRank < len(failurePriority)
}

// containerFailure reports why a container is failing, if it is.
func containerFailure(p *corev1.Pod, cs corev1.ContainerStatus, now time.Time) (failure, bool) {
	oom := func(t *corev1.ContainerStateTerminated) failure {
		f := failure{reason: reasonOOMKilled, pod: p.Name, at: finished(t)}
		if lim := memoryLimit(p.Spec, cs.Name); lim != "" {
			f.detail = "limit " + lim
		}
		return f
	}
	last := cs.LastTerminationState.Terminated
	if t := cs.State.Terminated; t != nil && t.Reason == reasonOOMKilled {
		return oom(t), true
	}
	if wt := cs.State.Waiting; wt != nil {
		switch wt.Reason {
		case reasonCrashLoop:
			if last != nil && last.Reason == reasonOOMKilled {
				return oom(last), true
			}
			f := failure{reason: reasonCrashLoop, pod: p.Name, at: finished(last)}
			if last != nil {
				f.detail = fmt.Sprintf("exit %d", last.ExitCode)
			}
			return f, true
		case reasonErrImagePull, reasonImagePullBackOff:
			return failure{reason: reasonImagePullBackOff, pod: p.Name, detail: containerImage(p.Spec, cs.Name)}, true
		case reasonConfigError:
			return failure{reason: reasonConfigError, pod: p.Name, detail: truncate(wt.Message, maxDetailLen)}, true
		}
	}
	if last != nil && last.Reason == reasonOOMKilled && (last.FinishedAt.IsZero() || now.Sub(last.FinishedAt.Time) <= recentOOMWindow) {
		return oom(last), true
	}
	return failure{}, false
}

// unschedulable reports a pending pod the scheduler could not place.
func unschedulable(p *corev1.Pod) bool {
	if p.Status.Phase != corev1.PodPending {
		return false
	}
	for _, c := range p.Status.Conditions {
		if c.Type == corev1.PodScheduled && c.Status == corev1.ConditionFalse {
			return true
		}
	}
	return false
}

func finished(t *corev1.ContainerStateTerminated) *time.Time {
	if t == nil || t.FinishedAt.IsZero() {
		return nil
	}
	at := t.FinishedAt.UTC()
	return &at
}

// memoryLimit returns a container's memory limit ("20Mi"), "" when unset.
func memoryLimit(spec corev1.PodSpec, container string) string {
	c := findContainer(spec, container)
	if c == nil {
		return ""
	}
	if q, ok := c.Resources.Limits[corev1.ResourceMemory]; ok {
		return q.String()
	}
	return ""
}

func containerImage(spec corev1.PodSpec, container string) string {
	if c := findContainer(spec, container); c != nil {
		return c.Image
	}
	return ""
}

func findContainer(spec corev1.PodSpec, name string) *corev1.Container {
	for _, list := range [][]corev1.Container{spec.Containers, spec.InitContainers} {
		for i := range list {
			if list[i].Name == name {
				return &list[i]
			}
		}
	}
	return nil
}

// shortPod trims a pod's generated suffix: "web-659fd8c9b4-x7k2p" becomes
// "web-659fd…"; short suffixes ("db-0") stay.
func shortPod(workload, pod string) string {
	rest, ok := strings.CutPrefix(pod, workload+"-")
	if !ok || len(rest) <= podHashChars {
		return pod
	}
	return workload + "-" + rest[:podHashChars] + ellipsis
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + ellipsis
}
