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
	client             *http.Client
	cache              map[string]any
	mu                 sync.RWMutex
}

type valueResponse struct {
	Value any `json:"value"`
}

type valuesResponse struct {
	Values map[string]any `json:"values"`
}

// NewConfigClient creates a new configuration client.
// Pass empty strings to use environment variable defaults.
func NewConfigClient(baseURL, apiKey, orgID string) *ConfigClient {
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

	return &ConfigClient{
		baseURL:            strings.TrimRight(baseURL, "/"),
		orgID:              orgID,
		defaultEnvironment: defaultEnv,
		client: &http.Client{
			Transport: &authTransport{
				apiKey: apiKey,
				base:   http.DefaultTransport,
			},
		},
		cache: make(map[string]any),
	}
}

// NewConfigClientFromEnv creates a client using only environment variables.
// Requires SMOOAI_CONFIG_API_URL, SMOOAI_CONFIG_API_KEY, and SMOOAI_CONFIG_ORG_ID.
func NewConfigClientFromEnv() *ConfigClient {
	return NewConfigClient("", "", "")
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

// GetValue retrieves a single config value for the given key and environment.
// Pass empty string for environment to use the default.
// Results are cached locally after the first fetch.
func (c *ConfigClient) GetValue(key, environment string) (any, error) {
	env := c.resolveEnv(environment)
	cacheKey := env + ":" + key

	c.mu.RLock()
	if val, ok := c.cache[cacheKey]; ok {
		c.mu.RUnlock()
		return val, nil
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
	c.cache[cacheKey] = result.Value
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
	for key, value := range result.Values {
		c.cache[env+":"+key] = value
	}
	c.mu.Unlock()

	return result.Values, nil
}

// InvalidateCache clears all locally cached values.
func (c *ConfigClient) InvalidateCache() {
	c.mu.Lock()
	c.cache = make(map[string]any)
	c.mu.Unlock()
}

// Close releases resources held by the client.
func (c *ConfigClient) Close() {
	c.client.CloseIdleConnections()
}
