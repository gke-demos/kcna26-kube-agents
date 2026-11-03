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
	"encoding/json"
	"errors"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// rootSyncPath is Config Sync's root RootSync, as the fleet installs it.
const rootSyncPath = "/apis/configsync.gke.io/v1beta1/namespaces/config-management-system/rootsyncs/root-sync"

var errNoRESTClient = errors.New("client has no REST client")

// rootSyncStatus is the part of a RootSync the console reads.
type rootSyncStatus struct {
	Status struct {
		Sync struct {
			Commit string `json:"commit"`
		} `json:"sync"`
	} `json:"status"`
}

// readSyncCommit returns the fleet-repo commit the cluster's Config Sync has
// applied. A var so tests can stub it (the fake clientset has no REST client).
var readSyncCommit = func(ctx context.Context, client kubernetes.Interface) (string, error) {
	rc, ok := client.Discovery().RESTClient().(*rest.RESTClient)
	if !ok || rc == nil {
		return "", errNoRESTClient
	}
	raw, err := rc.Get().AbsPath(rootSyncPath).DoRaw(ctx)
	if err != nil {
		return "", err
	}
	var rs rootSyncStatus
	if err := json.Unmarshal(raw, &rs); err != nil {
		return "", err
	}
	return rs.Status.Sync.Commit, nil
}
