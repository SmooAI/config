package config

import (
	"encoding/json"
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

// EvaluateFeatureFlagResponse is the body returned by
// POST /config/feature-flags/{key}/evaluate.
type EvaluateFeatureFlagResponse struct {
	// Value is the resolved flag value — shape depends on the flag definition.
	Value any `json:"value"`
	// MatchedRuleID is the id of the rule that fired, if any.
	MatchedRuleID string `json:"matchedRuleId,omitempty"`
	// RolloutBucket is the 0-99 bucket the context was assigned, if rollout ran.
	RolloutBucket *int `json:"rolloutBucket,omitempty"`
	// Source is which branch of the evaluator produced the value:
	// "raw", "rule", "rollout", or "default".
	Source string `json:"source"`
}

// EvaluateFeatureFlag evaluates a cohort-aware feature flag for a given context.
//
// Always hits the server so rules stay hot-reloadable without re-deploying
// consumer code. Unlike GetValue, this method is NOT cached — cohort rules
// can depend on per-request user context.
//
// Pass empty string for environment to use the client's default. Pass nil or
// an empty map for context if the flag doesn't reference any attributes.
func (c *ConfigClient) EvaluateFeatureFlag(key string, context map[string]any, environment string) (*EvaluateFeatureFlagResponse, error) {
	env := c.resolveEnv(environment)
	if context == nil {
		context = map[string]any{}
	}
	body, err := json.Marshal(map[string]any{"environment": env, "context": context})
	if err != nil {
		return nil, fmt.Errorf("config evaluate feature flag marshal: %w", err)
	}

	u := fmt.Sprintf("%s/organizations/%s/config/feature-flags/%s/evaluate",
		c.baseURL, c.orgID, url.PathEscape(key))

	resp, err := c.client.Post(u, "application/json", strings.NewReader(string(body)))
	if err != nil {
		return nil, fmt.Errorf("config evaluate feature flag: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("config evaluate feature flag: HTTP %d: %s", resp.StatusCode, string(b))
	}

	var result EvaluateFeatureFlagResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("config evaluate feature flag decode: %w", err)
	}
	return &result, nil
}

// SeedCacheFromMap pre-populates the local cache from an already-fetched map.
//
// Useful for cold-start hydration from a baked config blob — the caller
// decrypts the blob and feeds the map in, so subsequent GetValue calls
// resolve synchronously without hitting the HTTP API.
//
// Pass empty string for environment to use the default.
func (c *ConfigClient) SeedCacheFromMap(values map[string]any, environment string) {
	env := c.resolveEnv(environment)
	c.mu.Lock()
	expiresAt := c.computeExpiresAt()
	for key, value := range values {
		c.cache[env+":"+key] = cacheEntry{value: value, expiresAt: expiresAt}
	}
	c.mu.Unlock()
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
