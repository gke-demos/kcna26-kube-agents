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
	"testing"
)

func TestOnlyNamed(t *testing.T) {
	cs := []gkeCluster{{Name: "kube-agents-stg"}, {Name: "boutique-stg"}, {Name: "someone-elses"}}
	names := func(cs []gkeCluster) string {
		var out []string
		for _, c := range cs {
			out = append(out, c.Name)
		}
		return fmt.Sprint(out)
	}
	if got := names(onlyNamed(cs, nil)); got != "[kube-agents-stg boutique-stg someone-elses]" {
		t.Errorf("no allowlist: %s", got)
	}
	if got := names(onlyNamed(cs, []string{"boutique-stg", "kube-agents-stg", "absent"})); got != "[kube-agents-stg boutique-stg]" {
		t.Errorf("allowlist: %s", got)
	}
	if len(cs) != 3 || cs[2].Name != "someone-elses" {
		t.Errorf("input modified: %v", cs)
	}
}
