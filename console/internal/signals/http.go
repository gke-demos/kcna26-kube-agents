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

package signals

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

const (
	// maxRetries is how many times one request is retried after a 429.
	maxRetries = 3
	// defaultRetryAfter is the wait when a 429 carries no Retry-After.
	defaultRetryAfter = 2 * time.Second
	// maxRetryAfter caps a server-requested wait.
	maxRetryAfter = time.Minute
	// maxBody bounds a response body read into memory.
	maxBody             = 8 << 20
	headerAuthorization = "Authorization"
	headerRetryAfter    = "Retry-After"
	bearerPrefix        = "Bearer "
)

// response is a finished request: status, headers and body.
type response struct {
	status int
	header http.Header
	body   []byte
}

// do sends a GET with the bearer token and extra headers, waiting out 429s
// (and 403s that carry Retry-After, GitHub's secondary limit). The token is
// never part of an error.
func do(ctx context.Context, c *http.Client, url, token string, hdr map[string]string) (*response, error) {
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set(headerAuthorization, bearerPrefix+token)
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		resp, err := c.Do(req)
		if err != nil {
			return nil, err
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
		resp.Body.Close()
		if err != nil {
			return nil, err
		}
		limited := resp.StatusCode == http.StatusTooManyRequests ||
			(resp.StatusCode == http.StatusForbidden && resp.Header.Get(headerRetryAfter) != "")
		if !limited {
			return &response{status: resp.StatusCode, header: resp.Header, body: body}, nil
		}
		if attempt >= maxRetries {
			return nil, fmt.Errorf("rate limited (HTTP %d) after %d retries", resp.StatusCode, maxRetries)
		}
		if err := sleep(ctx, retryAfter(resp.Header.Get(headerRetryAfter))); err != nil {
			return nil, err
		}
	}
}

// retryAfter parses a Retry-After header in seconds.
func retryAfter(v string) time.Duration {
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return defaultRetryAfter
	}
	return min(time.Duration(n)*time.Second, maxRetryAfter)
}

// sleep waits d or until ctx ends.
func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
