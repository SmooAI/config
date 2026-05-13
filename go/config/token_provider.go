package config

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// TokenProvider exchanges (clientID, clientSecret) for an OAuth access
// token at {AuthURL}/token and caches the JWT in memory until it's
// within RefreshWindow of expiry.
//
// Parity with src/platform/TokenProvider.ts (SMOODEV-974) and
// python/src/smooai_config/token_provider.py. Extracted from ConfigClient
// so the same logic can be shared, mocked in tests, and reused by other
// in-package callers.
//
// Server contract:
//
//	POST {AuthURL}/token
//	Content-Type: application/x-www-form-urlencoded
//
//	grant_type=client_credentials
//	provider=client_credentials
//	client_id=<uuid>
//	client_secret=sk_...
//
// SMOODEV-975: replaces the previous "Authorization: Bearer <apiKey>"
// shortcut that the backend rejects with 401 because it expects a JWT.
type TokenProvider struct {
	authURL       string
	clientID      string
	clientSecret  string
	refreshWindow time.Duration
	httpClient    *http.Client

	mu              sync.Mutex
	cachedToken     string
	cachedExpiresAt time.Time
	// nowFn is a test seam so unit tests can pin the clock.
	nowFn func() time.Time
}

// TokenProviderOption configures a TokenProvider.
type TokenProviderOption func(*TokenProvider)

// WithTokenProviderRefreshWindow controls how many seconds before expiry to
// proactively refresh the cached token. Defaults to 60s — matches the .NET
// and TypeScript TokenProvider defaults.
func WithTokenProviderRefreshWindow(d time.Duration) TokenProviderOption {
	return func(t *TokenProvider) { t.refreshWindow = d }
}

// WithTokenProviderHTTPClient injects an *http.Client. Useful in tests to
// stub the token endpoint; otherwise leave nil to use http.DefaultClient.
func WithTokenProviderHTTPClient(client *http.Client) TokenProviderOption {
	return func(t *TokenProvider) { t.httpClient = client }
}

// NewTokenProvider constructs a TokenProvider. Returns an error if any of
// authURL / clientID / clientSecret is empty.
func NewTokenProvider(authURL, clientID, clientSecret string, opts ...TokenProviderOption) (*TokenProvider, error) {
	if authURL == "" {
		return nil, errors.New("@smooai/config: TokenProvider requires authURL")
	}
	if clientID == "" {
		return nil, errors.New("@smooai/config: TokenProvider requires clientID")
	}
	if clientSecret == "" {
		return nil, errors.New("@smooai/config: TokenProvider requires clientSecret")
	}
	t := &TokenProvider{
		authURL:       strings.TrimRight(authURL, "/"),
		clientID:      clientID,
		clientSecret:  clientSecret,
		refreshWindow: 60 * time.Second,
		httpClient:    http.DefaultClient,
		nowFn:         time.Now,
	}
	for _, opt := range opts {
		opt(t)
	}
	if t.httpClient == nil {
		t.httpClient = http.DefaultClient
	}
	return t, nil
}

// GetAccessToken returns a valid OAuth access token, refreshing if the
// cached value is missing or within the refresh window of expiry.
// Concurrent callers serialize through a mutex and share a single
// refreshed token rather than issuing parallel exchanges.
func (t *TokenProvider) GetAccessToken(ctx context.Context) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.shouldRefresh() {
		return t.cachedToken, nil
	}
	return t.refresh(ctx)
}

// Invalidate clears the cached token so the next GetAccessToken call
// re-exchanges. Used by callers that observed a 401 from a downstream
// request and want to retry once with a fresh token.
func (t *TokenProvider) Invalidate() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.cachedToken = ""
	t.cachedExpiresAt = time.Time{}
}

// shouldRefresh must be called under t.mu.
func (t *TokenProvider) shouldRefresh() bool {
	if t.cachedToken == "" {
		return true
	}
	return !t.nowFn().Before(t.cachedExpiresAt.Add(-t.refreshWindow))
}

// refresh must be called under t.mu.
func (t *TokenProvider) refresh(ctx context.Context) (string, error) {
	form := url.Values{}
	form.Set("grant_type", "client_credentials")
	form.Set("provider", "client_credentials")
	form.Set("client_id", t.clientID)
	form.Set("client_secret", t.clientSecret)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.authURL+"/token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", fmt.Errorf("@smooai/config: build OAuth request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := t.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("@smooai/config: OAuth token exchange: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("@smooai/config: OAuth token exchange failed: HTTP %d %s", resp.StatusCode, string(body))
	}
	var parsed struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", fmt.Errorf("@smooai/config: OAuth response not JSON: %w", err)
	}
	if parsed.AccessToken == "" {
		return "", errors.New("@smooai/config: OAuth token endpoint returned no access_token")
	}
	expiresIn := parsed.ExpiresIn
	if expiresIn <= 0 {
		expiresIn = 3600
	}
	t.cachedToken = parsed.AccessToken
	t.cachedExpiresAt = t.nowFn().Add(time.Duration(expiresIn) * time.Second)
	return parsed.AccessToken, nil
}

// setNowForTests overrides the clock. Test-only.
func (t *TokenProvider) setNowForTests(fn func() time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.nowFn = fn
}
