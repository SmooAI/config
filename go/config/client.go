package config

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// ConfigClient reads configuration values from the Smoo AI config server.
//
// Environment variables (used as defaults when constructor args are empty):
//
//	SMOOAI_CONFIG_API_URL  — Base URL of the config API
//	SMOOAI_CONFIG_API_KEY  — Bearer token for authentication
//	SMOOAI_CONFIG_ORG_ID   — Organization ID
//	SMOOAI_CONFIG_ENV      — Default environment name (e.g. "production")
type ConfigClient struct {
	baseURL            string
	orgID              string
	defaultEnvironment string
	cacheTTL           time.Duration
	client             *http.Client
	cache              map[string]cacheEntry
	mu                 sync.RWMutex
}

type cacheEntry struct {
	value     any
	expiresAt time.Time // zero means no expiry
}

type valueResponse struct {
	Value any `json:"value"`
}

type valuesResponse struct {
	Values map[string]any `json:"values"`
}

// ConfigClientOption configures a ConfigClient.
type ConfigClientOption func(*ConfigClient)

// WithCacheTTL sets the cache time-to-live duration.
// Zero (default) means cache never expires.
func WithCacheTTL(ttl time.Duration) ConfigClientOption {
	return func(c *ConfigClient) {
		c.cacheTTL = ttl
	}
}

// NewConfigClient creates a new configuration client.
// Pass empty strings to use environment variable defaults.
func NewConfigClient(baseURL, apiKey, orgID string, opts ...ConfigClientOption) *ConfigClient {
	if baseURL == "" {
		baseURL = os.Getenv("SMOOAI_CONFIG_API_URL")
	}
	if apiKey == "" {
		apiKey = os.Getenv("SMOOAI_CONFIG_API_KEY")
	}
	if orgID == "" {
		orgID = os.Getenv("SMOOAI_CONFIG_ORG_ID")
	}

	defaultEnv := os.Getenv("SMOOAI_CONFIG_ENV")
	if defaultEnv == "" {
		defaultEnv = "development"
	}

	c := &ConfigClient{
		baseURL:            strings.TrimRight(baseURL, "/"),
		orgID:              orgID,
		defaultEnvironment: defaultEnv,
		client: &http.Client{
			Transport: &authTransport{
				apiKey: apiKey,
				base:   http.DefaultTransport,
			},
		},
		cache: make(map[string]cacheEntry),
	}

	for _, opt := range opts {
		opt(c)
	}

	return c
}

// NewConfigClientFromEnv creates a client using only environment variables.
// Requires SMOOAI_CONFIG_API_URL, SMOOAI_CONFIG_API_KEY, and SMOOAI_CONFIG_ORG_ID.
func NewConfigClientFromEnv(opts ...ConfigClientOption) *ConfigClient {
	return NewConfigClient("", "", "", opts...)
}

type authTransport struct {
	apiKey string
	base   http.RoundTripper
}

func (t *authTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req.Header.Set("Authorization", "Bearer "+t.apiKey)
	return t.base.RoundTrip(req)
}

func (c *ConfigClient) resolveEnv(environment string) string {
	if environment != "" {
		return environment
	}
	return c.defaultEnvironment
}

func (c *ConfigClient) computeExpiresAt() time.Time {
	if c.cacheTTL > 0 {
		return time.Now().Add(c.cacheTTL)
	}
	return time.Time{}
}

// GetValue retrieves a single config value for the given key and environment.
// Pass empty string for environment to use the default.
// Results are cached locally after the first fetch.
func (c *ConfigClient) GetValue(key, environment string) (any, error) {
	env := c.resolveEnv(environment)
	cacheKey := env + ":" + key

	c.mu.RLock()
	if entry, ok := c.cache[cacheKey]; ok {
		if entry.expiresAt.IsZero() || time.Now().Before(entry.expiresAt) {
			c.mu.RUnlock()
			return entry.value, nil
		}
		// Expired — fall through to fetch
	}
	c.mu.RUnlock()

	u := fmt.Sprintf("%s/organizations/%s/config/values/%s?environment=%s",
		c.baseURL, c.orgID, url.PathEscape(key), url.QueryEscape(env))

	resp, err := c.client.Get(u)
	if err != nil {
		return nil, fmt.Errorf("config get value: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("config get value: HTTP %d: %s", resp.StatusCode, string(body))
	}

	var result valueResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("config get value decode: %w", err)
	}

	c.mu.Lock()
	c.cache[cacheKey] = cacheEntry{value: result.Value, expiresAt: c.computeExpiresAt()}
	c.mu.Unlock()

	return result.Value, nil
}

// GetAllValues retrieves all config values for the given environment.
// Pass empty string for environment to use the default.
// All values are cached locally after the fetch.
func (c *ConfigClient) GetAllValues(environment string) (map[string]any, error) {
	env := c.resolveEnv(environment)

	u := fmt.Sprintf("%s/organizations/%s/config/values?environment=%s",
		c.baseURL, c.orgID, url.QueryEscape(env))

	resp, err := c.client.Get(u)
	if err != nil {
		return nil, fmt.Errorf("config get all values: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("config get all values: HTTP %d: %s", resp.StatusCode, string(body))
	}

	var result valuesResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("config get all values decode: %w", err)
	}

	c.mu.Lock()
	expiresAt := c.computeExpiresAt()
	for key, value := range result.Values {
		c.cache[env+":"+key] = cacheEntry{value: value, expiresAt: expiresAt}
	}
	c.mu.Unlock()

	return result.Values, nil
}

// InvalidateCache clears all locally cached values.
func (c *ConfigClient) InvalidateCache() {
	c.mu.Lock()
	c.cache = make(map[string]cacheEntry)
	c.mu.Unlock()
}

// InvalidateCacheForEnvironment clears cached values for a specific environment.
func (c *ConfigClient) InvalidateCacheForEnvironment(environment string) {
	prefix := environment + ":"
	c.mu.Lock()
	for key := range c.cache {
		if strings.HasPrefix(key, prefix) {
			delete(c.cache, key)
		}
	}
	c.mu.Unlock()
}

// Close releases resources held by the client.
func (c *ConfigClient) Close() {
	c.client.CloseIdleConnections()
}

// EvaluateFeatureFlagResponse is the wire contract for the cohort-aware
// feature-flag evaluator. It mirrors the TS `EvaluateFeatureFlagResponse`
// and the schema defined in `@smooai/schemas/config/feature-flag`.
type EvaluateFeatureFlagResponse struct {
	// Value is the resolved flag value (post rules + rollout).
	Value any `json:"value"`
	// MatchedRuleID is the id of the rule that fired, if any.
	MatchedRuleID *string `json:"matchedRuleId,omitempty"`
	// RolloutBucket is the 0-99 bucket the context was assigned to, if a rollout ran.
	RolloutBucket *int `json:"rolloutBucket,omitempty"`
	// Source is which branch the evaluator returned from: "raw" | "rule" | "rollout" | "default".
	Source string `json:"source"`
}

// FeatureFlagErrorKind categorizes errors from EvaluateFeatureFlag so callers
// can branch on 404 / 400 / 5xx without parsing messages.
type FeatureFlagErrorKind int

const (
	// FeatureFlagKindServer covers 5xx responses and any non-404 / non-400 HTTP errors.
	FeatureFlagKindServer FeatureFlagErrorKind = iota
	// FeatureFlagKindNotFound is a 404 — the flag key is not defined in the org's schema.
	FeatureFlagKindNotFound
	// FeatureFlagKindContext is a 400 — invalid context or missing environment.
	FeatureFlagKindContext
)

// String returns the lowercase name of the kind. Handy for logs.
func (k FeatureFlagErrorKind) String() string {
	switch k {
	case FeatureFlagKindNotFound:
		return "not_found"
	case FeatureFlagKindContext:
		return "context"
	default:
		return "server"
	}
}

// Sentinel errors so callers can use `errors.Is` to match an error category
// without taking a dependency on the concrete `FeatureFlagEvaluationError`.
var (
	// ErrFeatureFlagNotFound matches any FeatureFlagEvaluationError with Kind == FeatureFlagKindNotFound.
	ErrFeatureFlagNotFound = errors.New("feature flag not found")
	// ErrFeatureFlagContext matches any FeatureFlagEvaluationError with Kind == FeatureFlagKindContext.
	ErrFeatureFlagContext = errors.New("feature flag context invalid")
	// ErrFeatureFlagServer matches any FeatureFlagEvaluationError with Kind == FeatureFlagKindServer.
	ErrFeatureFlagServer = errors.New("feature flag server error")
)

// FeatureFlagEvaluationError is returned from EvaluateFeatureFlag when the
// server rejects the request or returns a non-2xx status. Use the Kind field
// (or errors.Is with the sentinel vars) to branch on 404 / 400 / 5xx.
type FeatureFlagEvaluationError struct {
	// Key is the feature-flag key the caller asked to evaluate.
	Key string
	// StatusCode is the HTTP status returned by the server.
	StatusCode int
	// Kind categorizes the error (not found / context / server).
	Kind FeatureFlagErrorKind
	// ServerMessage is the raw response body text, if any.
	ServerMessage string
}

// Error implements the error interface.
func (e *FeatureFlagEvaluationError) Error() string {
	if e.ServerMessage != "" {
		return fmt.Sprintf("feature flag %q evaluation failed: HTTP %d — %s", e.Key, e.StatusCode, e.ServerMessage)
	}
	return fmt.Sprintf("feature flag %q evaluation failed: HTTP %d", e.Key, e.StatusCode)
}

// Is supports errors.Is matching against the sentinel errors above.
func (e *FeatureFlagEvaluationError) Is(target error) bool {
	switch target {
	case ErrFeatureFlagNotFound:
		return e.Kind == FeatureFlagKindNotFound
	case ErrFeatureFlagContext:
		return e.Kind == FeatureFlagKindContext
	case ErrFeatureFlagServer:
		return e.Kind == FeatureFlagKindServer
	}
	return false
}

// EvaluateFeatureFlag evaluates a cohort-aware feature flag against the server.
//
// Unlike GetValue, this is always a network call: cohort rules (percentage
// rollout, attribute matching, bucketing) live server-side and the response
// depends on the `evalContext` you pass. Callers that don't need cohort
// evaluation should keep using GetValue for the static flag value.
//
// Parameters:
//   - ctx: standard context for cancellation / deadline.
//   - key: feature-flag key.
//   - evalContext: attributes the server's cohort rules may reference
//     (e.g. {userId, tenantId, plan, country}). Unreferenced keys are ignored
//     by the server. Keep values JSON-serializable — the server hashes
//     `bucketBy` values by their string representation, so numbers and
//     booleans bucket stably across client rebuilds. A nil map is sent as {}.
//   - environment: environment name. Pass an empty string to use the client's
//     default environment.
//
// Errors:
//   - *FeatureFlagEvaluationError with Kind == FeatureFlagKindNotFound on 404.
//   - *FeatureFlagEvaluationError with Kind == FeatureFlagKindContext on 400.
//   - *FeatureFlagEvaluationError with Kind == FeatureFlagKindServer for 5xx
//     and other non-2xx responses.
//   - Wrapped network / decode errors from the underlying HTTP client.
func (c *ConfigClient) EvaluateFeatureFlag(
	ctx context.Context,
	key string,
	evalContext map[string]any,
	environment string,
) (*EvaluateFeatureFlagResponse, error) {
	env := c.resolveEnv(environment)

	if evalContext == nil {
		evalContext = map[string]any{}
	}

	body, err := json.Marshal(struct {
		Environment string         `json:"environment"`
		Context     map[string]any `json:"context"`
	}{
		Environment: env,
		Context:     evalContext,
	})
	if err != nil {
		return nil, fmt.Errorf("config evaluate feature flag %q: marshal body: %w", key, err)
	}

	u := fmt.Sprintf("%s/organizations/%s/config/feature-flags/%s/evaluate",
		c.baseURL, c.orgID, url.PathEscape(key))

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("config evaluate feature flag %q: build request: %w", key, err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("config evaluate feature flag %q: %w", key, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(resp.Body)
		kind := FeatureFlagKindServer
		switch resp.StatusCode {
		case http.StatusNotFound:
			kind = FeatureFlagKindNotFound
		case http.StatusBadRequest:
			kind = FeatureFlagKindContext
		}
		return nil, &FeatureFlagEvaluationError{
			Key:           key,
			StatusCode:    resp.StatusCode,
			Kind:          kind,
			ServerMessage: strings.TrimSpace(string(msg)),
		}
	}

	var result EvaluateFeatureFlagResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("config evaluate feature flag %q: decode response: %w", key, err)
	}

	return &result, nil
}
