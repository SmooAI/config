// Package bootstrap provides a lightweight cold-start config fetcher
// for the Smoo AI config platform.
//
// Unlike the main config client, this package has *zero* imports from
// other parts of the smooai-config module and depends only on the Go
// standard library (net/http, encoding/json, etc.). It exists for
// deploy scripts, container entry-points, and other cold-start
// contexts where the full SDK is too heavy or pulls in a transitive
// dependency that breaks the host runtime.
//
// It performs a single OAuth client_credentials exchange, then a
// single GET against /organizations/{orgId}/config/values, caching the
// values map per-process per-env so repeated reads in the same process
// avoid the round-trip.
//
// Inputs (from os.Getenv):
//
//	SMOOAI_CONFIG_API_URL       base URL (default https://api.smoo.ai)
//	SMOOAI_CONFIG_AUTH_URL      OAuth base URL (default https://auth.smoo.ai;
//	                            legacy SMOOAI_AUTH_URL also accepted)
//	SMOOAI_CONFIG_CLIENT_ID     OAuth M2M client id
//	SMOOAI_CONFIG_CLIENT_SECRET OAuth M2M client secret
//	                            (legacy SMOOAI_CONFIG_API_KEY accepted)
//	SMOOAI_CONFIG_ORG_ID        target org id
//	SMOOAI_CONFIG_ENV           default env name (fallback when no SST stage)
package bootstrap

import (
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

// Option configures a Fetch call.
type Option func(*options)

type options struct {
	environment string
	httpClient  *http.Client
	getEnv      func(string) string
}

// WithEnvironment overrides the auto-detected environment name.
func WithEnvironment(env string) Option {
	return func(o *options) { o.environment = env }
}

// WithHTTPClient overrides the default *http.Client. Mainly for testing.
func WithHTTPClient(c *http.Client) Option {
	return func(o *options) { o.httpClient = c }
}

// withGetEnv overrides the env lookup. Test-only; not exported.
func withGetEnv(fn func(string) string) Option {
	return func(o *options) { o.getEnv = fn }
}

type creds struct {
	apiURL       string
	authURL      string
	clientID     string
	clientSecret string
	orgID        string
}

func readCreds(getEnv func(string) string) (creds, error) {
	c := creds{
		apiURL:       firstNonEmpty(getEnv("SMOOAI_CONFIG_API_URL"), "https://api.smoo.ai"),
		authURL:      firstNonEmpty(getEnv("SMOOAI_CONFIG_AUTH_URL"), getEnv("SMOOAI_AUTH_URL"), "https://auth.smoo.ai"),
		clientID:     getEnv("SMOOAI_CONFIG_CLIENT_ID"),
		clientSecret: firstNonEmpty(getEnv("SMOOAI_CONFIG_CLIENT_SECRET"), getEnv("SMOOAI_CONFIG_API_KEY")),
		orgID:        getEnv("SMOOAI_CONFIG_ORG_ID"),
	}
	if c.clientID == "" || c.clientSecret == "" || c.orgID == "" {
		return creds{}, errors.New(
			"[smooai-config/bootstrap] missing SMOOAI_CONFIG_{CLIENT_ID,CLIENT_SECRET,ORG_ID} in env. " +
				"Set these (e.g. via `pnpm sst shell --stage <stage>`) before calling Fetch.",
		)
	}
	return c, nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func resolveEnv(getEnv func(string) string, explicit string) string {
	if explicit != "" {
		return explicit
	}
	stage := getEnv("SST_STAGE")
	if stage == "" {
		stage = getEnv("NEXT_PUBLIC_SST_STAGE")
	}
	if stage == "" {
		raw := getEnv("SST_RESOURCE_App")
		if raw != "" {
			var parsed struct {
				Stage string `json:"stage"`
			}
			if err := json.Unmarshal([]byte(raw), &parsed); err == nil && parsed.Stage != "" {
				stage = parsed.Stage
			}
		}
	}
	if stage == "" {
		if v := getEnv("SMOOAI_CONFIG_ENV"); v != "" {
			return v
		}
		return "development"
	}
	if stage == "production" {
		return "production"
	}
	return stage
}

// Package-level cache: one values map per env name.
var (
	cacheMu     sync.Mutex
	cachedEnv   string
	cachedVals  map[string]any
	cacheLoaded bool
)

// resetCache clears the cache. Test-only.
func resetCache() {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	cachedEnv = ""
	cachedVals = nil
	cacheLoaded = false
}

// Fetch reads a single config value by camelCase key.
//
// Returns ("", nil) if the key is not present in the values map; does
// NOT return an error in that case. Only env, auth, and network
// failures produce errors.
//
// The full values map is cached per-process per-env after the first
// call so repeated reads inside the same process don't re-do the
// OAuth + GET round-trip.
func Fetch(ctx context.Context, key string, opts ...Option) (string, error) {
	o := &options{
		httpClient: &http.Client{Timeout: 30 * time.Second},
		getEnv:     os.Getenv,
	}
	for _, opt := range opts {
		opt(o)
	}

	env := resolveEnv(o.getEnv, o.environment)

	cacheMu.Lock()
	defer cacheMu.Unlock()

	if !cacheLoaded || cachedEnv != env {
		c, err := readCreds(o.getEnv)
		if err != nil {
			return "", err
		}
		token, err := mintAccessToken(ctx, o.httpClient, c)
		if err != nil {
			return "", err
		}
		vals, err := fetchValues(ctx, o.httpClient, c, token, env)
		if err != nil {
			return "", err
		}
		cachedVals = vals
		cachedEnv = env
		cacheLoaded = true
	}

	v, ok := cachedVals[key]
	if !ok || v == nil {
		return "", nil
	}
	switch t := v.(type) {
	case string:
		return t, nil
	case bool:
		if t {
			return "true", nil
		}
		return "false", nil
	case float64:
		// json.Unmarshal decodes numbers as float64 by default. Render
		// integers without trailing ".0" to match the other SDKs.
		if t == float64(int64(t)) {
			return fmt.Sprintf("%d", int64(t)), nil
		}
		return fmt.Sprintf("%g", t), nil
	default:
		return fmt.Sprintf("%v", t), nil
	}
}

func mintAccessToken(ctx context.Context, client *http.Client, c creds) (string, error) {
	authURL := strings.TrimRight(c.authURL, "/") + "/token"
	form := url.Values{}
	form.Set("grant_type", "client_credentials")
	form.Set("provider", "client_credentials")
	form.Set("client_id", c.clientID)
	form.Set("client_secret", c.clientSecret)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, authURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", fmt.Errorf("[smooai-config/bootstrap] build OAuth request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("[smooai-config/bootstrap] OAuth token exchange: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf(
			"[smooai-config/bootstrap] OAuth token exchange failed: HTTP %d %s",
			resp.StatusCode, string(body),
		)
	}
	var parsed struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", fmt.Errorf("[smooai-config/bootstrap] OAuth response not JSON: %w", err)
	}
	if parsed.AccessToken == "" {
		return "", errors.New("[smooai-config/bootstrap] OAuth token endpoint returned no access_token")
	}
	return parsed.AccessToken, nil
}

func fetchValues(ctx context.Context, client *http.Client, c creds, token, env string) (map[string]any, error) {
	apiURL := strings.TrimRight(c.apiURL, "/")
	u := fmt.Sprintf(
		"%s/organizations/%s/config/values?environment=%s",
		apiURL, url.PathEscape(c.orgID), url.QueryEscape(env),
	)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, fmt.Errorf("[smooai-config/bootstrap] build values request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("[smooai-config/bootstrap] GET /config/values: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf(
			"[smooai-config/bootstrap] GET /config/values failed: HTTP %d %s",
			resp.StatusCode, string(body),
		)
	}
	var parsed struct {
		Values map[string]any `json:"values"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("[smooai-config/bootstrap] values response not JSON: %w", err)
	}
	if parsed.Values == nil {
		return map[string]any{}, nil
	}
	return parsed.Values, nil
}
