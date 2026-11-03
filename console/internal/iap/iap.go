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

// Package iap identifies callers from Identity-Aware Proxy's signed header,
// so a request that reaches the pod without passing IAP (from inside the
// cluster, say) is refused.
package iap

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"google.golang.org/api/idtoken"
)

const (
	// AssertionHeader is the JWT IAP signs for every request it lets through.
	AssertionHeader = "X-Goog-Iap-Jwt-Assertion"
	issuer          = "https://cloud.google.com/iap"
	emailClaim      = "email"
)

// Verifier checks IAP assertions for one project's backend services.
type Verifier struct {
	// audiencePrefix is "/projects/<number>/global/backendServices/": IAP's
	// audience for a global backend, whose ID changes when the Gateway
	// re-creates it, so any backend of the project is accepted.
	audiencePrefix string
}

// New returns a verifier for projectNumber.
func New(projectNumber string) (*Verifier, error) {
	if projectNumber == "" || strings.Trim(projectNumber, "0123456789") != "" {
		return nil, fmt.Errorf("iap: project number must be digits, got %q", projectNumber)
	}
	return &Verifier{audiencePrefix: "/projects/" + projectNumber + "/global/backendServices/"}, nil
}

// Identify returns the caller's email.
func (v *Verifier) Identify(r *http.Request) (string, error) {
	tok := r.Header.Get(AssertionHeader)
	if tok == "" {
		return "", errors.New("no IAP assertion")
	}
	// An empty audience skips idtoken's own check; ours follows.
	p, err := idtoken.Validate(r.Context(), tok, "")
	if err != nil {
		return "", fmt.Errorf("iap assertion: %w", err)
	}
	if p.Issuer != issuer {
		return "", fmt.Errorf("iap assertion: issuer %q", p.Issuer)
	}
	if !strings.HasPrefix(p.Audience, v.audiencePrefix) {
		return "", fmt.Errorf("iap assertion: audience %q is not this project's", p.Audience)
	}
	email, _ := p.Claims[emailClaim].(string)
	if email == "" {
		return "", errors.New("iap assertion: no email")
	}
	return strings.ToLower(email), nil
}

// Fixed is an Identifier for local development: every request is who.
type Fixed string

// Identify returns the fixed identity.
func (f Fixed) Identify(*http.Request) (string, error) { return string(f), nil }
