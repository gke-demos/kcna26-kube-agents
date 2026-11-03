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

// Package model holds the collector's picture of a cluster (atespaces, agents,
// workers and the ax tasks behind agents) and the events that describe how it
// changes. Everything here is plain data that serializes to the JSON the front
// end reads.
package model

import (
	"time"
)

// Actor states, as Substrate names them without the ACTOR_STATE_ prefix.
// PAUSING and PAUSED are no longer Substrate states (v0.5 dropped them); the
// collector derives them from SUSPENDING/SUSPENDED and the actor's latest
// snapshot (see substrate.ToAgent).
const (
	StateUnspecified = "UNSPECIFIED"
	StateResuming    = "RESUMING"
	StateRunning     = "RUNNING"
	StateSuspending  = "SUSPENDING"
	StateSuspended   = "SUSPENDED"
	StatePausing     = "PAUSING"
	StatePaused      = "PAUSED"
	StateCrashed     = "CRASHED"
	StateDeleting    = "DELETING"
	StateReverting   = "REVERTING"
)

// ax condition reasons the fork records on a task's Ready condition.
const (
	ReasonIdleSuspended      = "IdleSuspended"
	ReasonCompletedSuspended = "CompletedSuspended"
	ReasonResumedByRequest   = "ResumedByRequest"
	ReasonActorSuspended     = "ActorSuspended"
)

// Agent is one Substrate actor, plus its ax task when it is one.
type Agent struct {
	Atespace string `json:"atespace"`
	Name     string `json:"name"`
	UID      string `json:"uid,omitempty"`
	State    string `json:"state"`
	// Template is the actor template as "atespace/name".
	Template string `json:"template,omitempty"`
	// Worker is the name of the worker hosting the actor; empty when it has none.
	Worker     string `json:"worker,omitempty"`
	WorkerPod  string `json:"workerPod,omitempty"`
	WorkerNode string `json:"workerNode,omitempty"`
	WorkerPool string `json:"workerPool,omitempty"`
	// WorkerIPs are the hosting worker pod's IPs (at most one per family,
	// primary family first). WorkerIP is the first non-empty one.
	WorkerIPs []string `json:"workerIPs,omitempty"`
	WorkerIP  string   `json:"workerIP,omitempty"`
	// WorkerEpoch is the worker's epoch when the actor was placed on it; 0
	// when the worker had not reported one.
	WorkerEpoch int64 `json:"workerEpoch,omitempty"`
	// AssignedNode is the node the actor is attached to: the one hosting its
	// worker, or holding its node-local snapshot while PAUSED. Empty when
	// detached.
	AssignedNode string `json:"assignedNode,omitempty"`
	// SnapshotURI is the actor's latest completed durable snapshot, if any.
	SnapshotURI string `json:"snapshotURI,omitempty"`
	// SnapshotInProgress is set while the actor is taking a snapshot (its
	// latest one is uploading, or is a local checkpoint not captured yet).
	SnapshotInProgress bool       `json:"snapshotInProgress,omitempty"`
	Crash              *Crash     `json:"crash,omitempty"`
	Version            int64      `json:"version,omitempty"`
	CreateTime         *time.Time `json:"createTime,omitempty"`
	UpdateTime         *time.Time `json:"updateTime,omitempty"`
	// StateSince is when the collector first saw the actor in its current
	// state (or the actor's update time when that is later, on startup).
	StateSince time.Time `json:"stateSince"`
	// Task is the ax task backed by this actor, nil if it isn't one.
	Task *Task `json:"task,omitempty"`

	// Workload fields (fleet-scope). An "agent" here is a Kubernetes
	// workload: Atespace is its cluster, Name its name, and State maps its
	// health onto the Substrate states the scene draws: RUNNING (all
	// replicas ready), RESUMING (rolling out), CRASHED (a pod OOMKilled,
	// crash-looping or failing to pull), SUSPENDED (scaled to zero),
	// UNSPECIFIED (pending: unschedulable or not started). Crash.Message
	// carries the failing reason.
	Kind      string `json:"kind,omitempty"`
	Namespace string `json:"namespace,omitempty"`
	Replicas  int32  `json:"replicas,omitempty"`
	Ready     int32  `json:"ready,omitempty"`
	// Reason is the most telling pod reason ("OOMKilled", "ImagePullBackOff",
	// "Unschedulable", "Progressing"), empty when healthy.
	Reason string `json:"reason,omitempty"`
	// Image and MemoryLimit are the first container's, for the panel.
	Image       string `json:"image,omitempty"`
	MemoryLimit string `json:"memoryLimit,omitempty"`
}

// Key returns "atespace/name", the identity used everywhere.
func (a *Agent) Key() string { return Key(a.Atespace, a.Name) }

// Key joins an atespace and a name.
func Key(atespace, name string) string { return atespace + "/" + name }

// Crash records why an actor crashed.
type Crash struct {
	Message string     `json:"message,omitempty"`
	Time    *time.Time `json:"time,omitempty"`
}

// Task is what ax knows about the task an actor runs.
type Task struct {
	// Name is the task's own name (metadata.name); its actor's name can differ.
	Name       string      `json:"name,omitempty"`
	Phase      string      `json:"phase,omitempty"`
	Image      string      `json:"image,omitempty"`
	Command    []string    `json:"command,omitempty"`
	Conditions []Condition `json:"conditions,omitempty"`
	// IdleSuspendAfter is spec.idle.suspendAfter ("10m"), empty when unset.
	IdleSuspendAfter string `json:"idleSuspendAfter,omitempty"`
	IdleBusyPath     string `json:"idleBusyPath,omitempty"`
	OnCompletion     string `json:"onCompletion,omitempty"`
	// HTTPPort is spec.http.port: the agent serves its own API through the
	// router when set.
	HTTPPort   int32      `json:"httpPort,omitempty"`
	CreateTime *time.Time `json:"createTime,omitempty"`
	Workspaces []string   `json:"workspaces,omitempty"`
}

// Ready returns the task's Ready condition, or nil.
func (t *Task) Ready() *Condition {
	if t == nil {
		return nil
	}
	for i := range t.Conditions {
		if t.Conditions[i].Type == "Ready" {
			return &t.Conditions[i]
		}
	}
	return nil
}

// Condition mirrors an ax task condition.
type Condition struct {
	Type               string     `json:"type"`
	Status             string     `json:"status"`
	Reason             string     `json:"reason,omitempty"`
	Message            string     `json:"message,omitempty"`
	LastTransitionTime *time.Time `json:"lastTransitionTime,omitempty"`
}

// Worker is a Substrate worker (a pod that hosts actors).
type Worker struct {
	Name         string `json:"name"`
	Pool         string `json:"pool,omitempty"`
	Pod          string `json:"pod,omitempty"`
	Namespace    string `json:"namespace,omitempty"`
	Node         string `json:"node,omitempty"`
	SandboxClass string `json:"sandboxClass,omitempty"`
	State        string `json:"state"`
	// IPs are the worker pod's IPs, at most one per family, primary first.
	IPs []string `json:"ips,omitempty"`
	// Epoch counts the runs of the worker's ateom (0: not reported).
	// ObservedEpoch trails it until the control plane has crashed the
	// actors placed before the last restart; while it is lower, some of
	// the worker's actors may be reported running but are gone.
	Epoch         int64 `json:"epoch,omitempty"`
	ObservedEpoch int64 `json:"observedEpoch,omitempty"`
	// CapacityActors and AllocatedActors are the worker's actor slots.
	CapacityActors  int32 `json:"capacityActors"`
	AllocatedActors int32 `json:"allocatedActors"`
	// CPU and memory capacity and allocation, as Kubernetes quantities
	// ("4", "500m", "16Gi"); empty when the worker doesn't report them.
	CapacityCPU     string `json:"capacityCpu,omitempty"`
	CapacityMemory  string `json:"capacityMemory,omitempty"`
	AllocatedCPU    string `json:"allocatedCpu,omitempty"`
	AllocatedMemory string `json:"allocatedMemory,omitempty"`
	// Actors are the keys of the actors assigned to this worker.
	Actors []string `json:"actors,omitempty"`
}

// Atespace is a Substrate atespace.
type Atespace struct {
	Name       string     `json:"name"`
	CreateTime *time.Time `json:"createTime,omitempty"`
}

// SourceStatus reports the health of one poller.
type SourceStatus struct {
	Name     string    `json:"name"`
	OK       bool      `json:"ok"`
	Error    string    `json:"error,omitempty"`
	LastPoll time.Time `json:"lastPoll"`
}

// Snapshot is the whole picture at one sequence number.
type Snapshot struct {
	Cluster   string         `json:"cluster"`
	Source    string         `json:"source"`
	Seq       uint64         `json:"seq"`
	Time      time.Time      `json:"time"`
	Atespaces []Atespace     `json:"atespaces"`
	Agents    []Agent        `json:"agents"`
	Workers   []Worker       `json:"workers"`
	Sources   []SourceStatus `json:"sources"`
	Features  Features       `json:"features"`
	// Recent are the latest signal events (oldest first), so a page that
	// opens mid-incident shows the alert and its links in the feed.
	Recent []Event `json:"recent"`
}

// Features tells the front end what the collector can do.
type Features struct {
	// Attach is true when the attach proxy is configured.
	Attach bool `json:"attach"`
	// RunnerStatus is true when the collector can read ax runner status
	// through the router.
	RunnerStatus bool `json:"runnerStatus"`
	// MastWeb is true when the collector serves mast-web for agents (needs
	// the attach proxy).
	MastWeb bool `json:"mastWeb"`
	// Raw is true when the collector serves agents' raw API objects
	// (redacted) for the panel's YAML view.
	Raw bool `json:"raw"`
	// Actions is true when the caller may press the trigger and reset
	// buttons (per request: the IAP identity is on the writers list).
	Actions bool `json:"actions"`
	// Links the header shows: the Slack channel, the fleet repo, storefronts.
	Links []Link `json:"links,omitempty"`
}

// Link is a named URL.
type Link struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}
