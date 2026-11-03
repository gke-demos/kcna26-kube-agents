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
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	"github.com/gke-demos/kcna26-kube-agents/console/internal/model"
)

var now = time.Date(2026, 11, 12, 15, 0, 0, 0, time.UTC)

func ptr[T any](v T) *T { return &v }

func deployment(name string, replicas, ready, updated int32) *appsv1.Deployment {
	return &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "boutique", UID: types.UID("uid-" + name), Generation: 2},
		Spec: appsv1.DeploymentSpec{
			Replicas: ptr(replicas),
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": name}},
			Template: corev1.PodTemplateSpec{Spec: corev1.PodSpec{Containers: []corev1.Container{{
				Name:      "server",
				Image:     "gcr.io/demo/" + name + ":v1",
				Resources: corev1.ResourceRequirements{Limits: corev1.ResourceList{corev1.ResourceMemory: resource.MustParse("20Mi")}},
			}}}},
		},
		Status: appsv1.DeploymentStatus{ObservedGeneration: 2, ReadyReplicas: ready, UpdatedReplicas: updated},
	}
}

// pod returns a pod of the named workload with one "server" container.
func pod(app, name string, cs corev1.ContainerStatus) corev1.Pod {
	cs.Name = "server"
	return corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "boutique", Labels: map[string]string{"app": app}},
		Spec: corev1.PodSpec{Containers: []corev1.Container{{
			Name:      "server",
			Image:     "gcr.io/demo/" + app + ":v2",
			Resources: corev1.ResourceRequirements{Limits: corev1.ResourceList{corev1.ResourceMemory: resource.MustParse("20Mi")}},
		}}},
		Status: corev1.PodStatus{Phase: corev1.PodRunning, ContainerStatuses: []corev1.ContainerStatus{cs}},
	}
}

func readyStatus() corev1.ContainerStatus {
	return corev1.ContainerStatus{Ready: true, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}
}

func waiting(reason string) corev1.ContainerStatus {
	return corev1.ContainerStatus{State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: reason}}}
}

func terminated(reason string, exit int32, at time.Time) *corev1.ContainerStateTerminated {
	return &corev1.ContainerStateTerminated{Reason: reason, ExitCode: exit, FinishedAt: metav1.NewTime(at)}
}

func TestAssess(t *testing.T) {
	oomLoop := waiting(reasonCrashLoop)
	oomLoop.LastTerminationState.Terminated = terminated(reasonOOMKilled, 137, now.Add(-30*time.Second))
	errLoop := waiting(reasonCrashLoop)
	errLoop.LastTerminationState.Terminated = terminated("Error", 1, now.Add(-10*time.Second))
	recovered := readyStatus()
	recovered.LastTerminationState.Terminated = terminated(reasonOOMKilled, 137, now.Add(-2*time.Minute))
	longAgo := readyStatus()
	longAgo.LastTerminationState.Terminated = terminated(reasonOOMKilled, 137, now.Add(-time.Hour))
	oomNow := corev1.ContainerStatus{State: corev1.ContainerState{Terminated: terminated(reasonOOMKilled, 137, now.Add(-time.Second))}}
	pending := corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "web-6d4f-abcde", Namespace: "boutique", Labels: map[string]string{"app": "web"}},
		Status: corev1.PodStatus{Phase: corev1.PodPending, Conditions: []corev1.PodCondition{{
			Type: corev1.PodScheduled, Status: corev1.ConditionFalse, Reason: "Unschedulable",
		}}},
	}
	other := pod("cart", "cart-7f9c8d-zzzzz", oomLoop)
	terminating := pod("web", "web-6d4f-old00", oomLoop)
	terminating.DeletionTimestamp = ptr(metav1.NewTime(now))

	tests := []struct {
		name        string
		dep         *appsv1.Deployment
		pods        []corev1.Pod
		state       string
		reason      string
		message     string
		wantCrashAt bool
	}{
		{
			name:  "healthy",
			dep:   deployment("web", 2, 2, 2),
			pods:  []corev1.Pod{pod("web", "web-6d4f-aaaaa", readyStatus()), pod("web", "web-6d4f-bbbbb", readyStatus()), other},
			state: model.StateRunning,
		},
		{
			name: "OOM during rollout: old pod ready, new pod crash-looping",
			dep:  deployment("recommendationservice", 1, 1, 1),
			pods: []corev1.Pod{
				pod("recommendationservice", "recommendationservice-5b8c7d6e9f-old11", readyStatus()),
				pod("recommendationservice", "recommendationservice-659fd8c9b4-x7k2p", oomLoop),
			},
			state:       model.StateCrashed,
			reason:      reasonOOMKilled,
			message:     "recommendationservice-659fd… OOMKilled (limit 20Mi)",
			wantCrashAt: true,
		},
		{
			name:    "OOM beats crash loop across pods",
			dep:     deployment("web", 2, 0, 2),
			pods:    []corev1.Pod{pod("web", "web-6d4f-aaaaa", errLoop), pod("web", "web-6d4f-bbbbb", oomLoop)},
			state:   model.StateCrashed,
			reason:  reasonOOMKilled,
			message: "web-6d4f-… OOMKilled (limit 20Mi)",
		},
		{
			name:    "currently terminated OOMKilled",
			dep:     deployment("web", 1, 0, 1),
			pods:    []corev1.Pod{pod("web", "web-6d4f-aaaaa", oomNow)},
			state:   model.StateCrashed,
			reason:  reasonOOMKilled,
			message: "web-6d4f-… OOMKilled (limit 20Mi)",
		},
		{
			name:    "recent OOM after the container came back",
			dep:     deployment("web", 1, 1, 1),
			pods:    []corev1.Pod{pod("web", "web-6d4f-aaaaa", recovered)},
			state:   model.StateCrashed,
			reason:  reasonOOMKilled,
			message: "web-6d4f-… OOMKilled (limit 20Mi)",
		},
		{
			name:  "old OOM is forgotten",
			dep:   deployment("web", 1, 1, 1),
			pods:  []corev1.Pod{pod("web", "web-6d4f-aaaaa", longAgo)},
			state: model.StateRunning,
		},
		{
			name:    "image pull backoff",
			dep:     deployment("web", 1, 1, 0),
			pods:    []corev1.Pod{pod("web", "web-6d4f-aaaaa", waiting(reasonImagePullBackOff))},
			state:   model.StateCrashed,
			reason:  reasonImagePullBackOff,
			message: "web-6d4f-… ImagePullBackOff (gcr.io/demo/web:v2)",
		},
		{
			name:    "ErrImagePull reads as ImagePullBackOff",
			dep:     deployment("web", 1, 1, 0),
			pods:    []corev1.Pod{pod("web", "web-6d4f-aaaaa", waiting(reasonErrImagePull))},
			state:   model.StateCrashed,
			reason:  reasonImagePullBackOff,
			message: "web-6d4f-… ImagePullBackOff (gcr.io/demo/web:v2)",
		},
		{
			name:        "crash loop",
			dep:         deployment("web", 1, 0, 1),
			pods:        []corev1.Pod{pod("web", "web-6d4f-aaaaa", errLoop)},
			state:       model.StateCrashed,
			reason:      reasonCrashLoop,
			message:     "web-6d4f-… CrashLoopBackOff (exit 1)",
			wantCrashAt: true,
		},
		{
			name:    "config error",
			dep:     deployment("web", 1, 0, 1),
			pods:    []corev1.Pod{pod("web", "web-6d4f-aaaaa", corev1.ContainerStatus{State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: reasonConfigError, Message: `secret "db" not found`}}})},
			state:   model.StateCrashed,
			reason:  reasonConfigError,
			message: `web-6d4f-… CreateContainerConfigError (secret "db" not found)`,
		},
		{
			name:   "unschedulable",
			dep:    deployment("web", 2, 1, 2),
			pods:   []corev1.Pod{pod("web", "web-6d4f-aaaaa", readyStatus()), pending},
			state:  model.StateUnspecified,
			reason: reasonUnschedulable,
		},
		{
			name:  "scaled to zero",
			dep:   deployment("web", 0, 0, 0),
			pods:  []corev1.Pod{terminating},
			state: model.StateSuspended,
		},
		{
			name:   "progressing: new pods not updated yet",
			dep:    deployment("web", 2, 2, 1),
			pods:   []corev1.Pod{pod("web", "web-6d4f-aaaaa", readyStatus())},
			state:  model.StateResuming,
			reason: reasonProgressing,
		},
		{
			name:   "progressing: not all ready",
			dep:    deployment("web", 3, 2, 3),
			pods:   []corev1.Pod{pod("web", "web-6d4f-aaaaa", waiting("ContainerCreating"))},
			state:  model.StateResuming,
			reason: reasonProgressing,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := fromDeployment(tt.dep)
			h := assess(w, podsFor(w, tt.pods), now)
			if h.State != tt.state || h.Reason != tt.reason {
				t.Fatalf("state %s/%s, want %s/%s", h.State, h.Reason, tt.state, tt.reason)
			}
			if tt.message == "" {
				if h.Crash != nil {
					t.Fatalf("crash %+v, want none", h.Crash)
				}
				return
			}
			if h.Crash == nil || h.Crash.Message != tt.message {
				t.Fatalf("crash %+v, want message %q", h.Crash, tt.message)
			}
			if tt.wantCrashAt && h.Crash.Time == nil {
				t.Fatalf("crash has no time")
			}
		})
	}
}

func TestStatefulSetOnDeleteIgnoresUpdated(t *testing.T) {
	s := &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Name: "db", Namespace: "bank"},
		Spec: appsv1.StatefulSetSpec{
			Replicas:       ptr(int32(1)),
			Selector:       &metav1.LabelSelector{MatchLabels: map[string]string{"app": "db"}},
			UpdateStrategy: appsv1.StatefulSetUpdateStrategy{Type: appsv1.OnDeleteStatefulSetStrategyType},
		},
		Status: appsv1.StatefulSetStatus{ReadyReplicas: 1},
	}
	if h := assess(fromStatefulSet(s), nil, now); h.State != model.StateRunning {
		t.Fatalf("OnDelete: state %s, want RUNNING", h.State)
	}
	s.Spec.UpdateStrategy.Type = appsv1.RollingUpdateStatefulSetStrategyType
	if h := assess(fromStatefulSet(s), nil, now); h.State != model.StateResuming {
		t.Fatalf("RollingUpdate: state %s, want RESUMING", h.State)
	}
}

func TestShortPod(t *testing.T) {
	for _, tt := range []struct{ workload, pod, want string }{
		{"web", "web-659fd8c9b4-x7k2p", "web-659fd…"},
		{"db", "db-0", "db-0"},
		{"web", "other-abcdefgh", "other-abcdefgh"},
	} {
		if got := shortPod(tt.workload, tt.pod); got != tt.want {
			t.Errorf("shortPod(%q, %q) = %q, want %q", tt.workload, tt.pod, got, tt.want)
		}
	}
}
