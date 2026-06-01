package container

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	config "github.com/SmooAI/config/go/config"
)

// DefaultCacheTTL is the default config-value cache TTL (§5). Same 30s default
// in every SDK. A background refresh failure serves the last-good value until
// this TTL hard-expires, at which point Health reports unhealthy.
const DefaultCacheTTL = 30 * time.Second

// DefaultTokenRefreshBufferSeconds is the default token proactive-refresh
// window in seconds (§5). Matches TokenProvider's default.
const DefaultTokenRefreshBufferSeconds = 60

// ConfigClient is the subset of *config.ConfigClient that container mode
// depends on. Declaring it as an interface lets tests inject a stub without a
// live HTTP server, mirroring the TS configClient injection seam.
type ConfigClient interface {
	GetAllValues(environment string) (map[string]any, error)
	GetValue(key, environment string) (any, error)
	GetCachedValue(key, environment string) (any, bool)
	SeedCache(key string, value any, environment string)
}

// TokenProvider is the subset of *config.TokenProvider container mode needs.
// Injectable for tests.
type TokenProvider interface {
	GetAccessToken(ctx context.Context) (string, error)
	Invalidate()
}

// InitContainerConfigOptions mirrors the §1 env contract so tests and embedders
// can construct a handle without touching the process environment. When a field
// is empty, the corresponding env var is read.
type InitContainerConfigOptions struct {
	// Schema is the config definition for this service (required). Its declared
	// keys are treated as required in container mode by default — see
	// OptionalKeys for the opt-out.
	Schema *config.ConfigDefinition

	// APIURL is the config API base URL. Falls back to SMOOAI_CONFIG_API_URL.
	APIURL string
	// AuthURL is the OAuth issuer base URL. Falls back to SMOOAI_CONFIG_AUTH_URL,
	// then legacy SMOOAI_AUTH_URL, then https://auth.smoo.ai.
	AuthURL string
	// ClientID is the M2M OAuth client id. Falls back to SMOOAI_CONFIG_CLIENT_ID.
	ClientID string
	// ClientSecret is the M2M OAuth client secret. Falls back to
	// SMOOAI_CONFIG_CLIENT_SECRET, then legacy SMOOAI_CONFIG_API_KEY.
	ClientSecret string
	// OrgID is the org id whose config to fetch. Falls back to SMOOAI_CONFIG_ORG_ID.
	OrgID string
	// Environment is the environment name (e.g. "production"). Falls back to
	// SMOOAI_CONFIG_ENV.
	Environment string

	// CacheTTL is the config-value cache TTL. Zero uses DefaultCacheTTL (30s).
	CacheTTL time.Duration
	// TokenRefreshBuffer is the seconds before token expiry to proactively
	// refresh. Zero uses DefaultTokenRefreshBufferSeconds (60s).
	TokenRefreshBuffer int

	// OptionalKeys are keys allowed to be absent. A read of any of these returns
	// the zero value with ok=false instead of a ConfigKeyUnresolvedError.
	// Everything else declared in Schema is required (container mode's
	// default-required posture).
	OptionalKeys []string

	// ConfigClient is a test/embedding seam — inject a pre-built client. When
	// supplied, APIURL/AuthURL/ClientID/ClientSecret/OrgID env validation is
	// skipped (the client already carries them) but Environment is still required.
	ConfigClient ConfigClient
	// TokenProvider is a test/embedding seam — inject a pre-built token provider.
	TokenProvider TokenProvider

	// EnvOverride replaces os.Getenv lookups (primarily for tests).
	EnvOverride map[string]string
}

// ConfigHealth is the status returned by ContainerConfigHandle.Health. Never an
// error. Status is "healthy" or "unhealthy"; Reason is populated when unhealthy.
type ConfigHealth struct {
	Status string
	Reason string
}

// IsHealthy reports whether the status is "healthy".
func (h ConfigHealth) IsHealthy() bool { return h.Status == "healthy" }

// tierAccessor exposes fail-loud reads for one schema tier (public / secret /
// feature flag). Get returns the resolved value or a ConfigKeyUnresolvedError
// (for required keys). MustGet panics on that error — the fail-loud "sync"
// analog of the TS getSync (§3).
type tierAccessor struct {
	handle *ContainerConfigHandle
	tier   string // "public" | "secret" | "featureFlag" (for messages)
}

// Get resolves a single key. For a key declared in the schema and not in
// OptionalKeys, a missing value returns a *ConfigKeyUnresolvedError rather than
// the zero value (§3 fail-loud). For an optional key, a missing value returns
// (nil, false, nil). ok reports whether a value was present.
func (a tierAccessor) Get(key string) (value any, ok bool, err error) {
	if key == "" {
		return nil, false, fmt.Errorf(
			"@smooai/config (container): %sConfig.Get called with empty key. "+
				"Most common cause: reading a key not declared in your schema", a.tier)
	}
	v, present, tried := a.handle.resolve(key)
	if present {
		return v, true, nil
	}
	if a.handle.isOptional(key) {
		return nil, false, nil
	}
	return nil, false, &ConfigKeyUnresolvedError{Key: key, Env: a.handle.environment, TriedTiers: tried}
}

// MustGet is the fail-loud sync analog of the TS getSync. It resolves a key
// from the env override or the local cache only (no network) and panics with a
// *ConfigKeyUnresolvedError when a required key is absent. Optional keys return
// (nil, false). Use Get for the error-returning form.
func (a tierAccessor) MustGet(key string) (value any, ok bool) {
	if key == "" {
		panic(fmt.Errorf(
			"@smooai/config (container): %sConfig.MustGet called with empty key. "+
				"Most common cause: reading a key not declared in your schema", a.tier))
	}
	v, present, tried := a.handle.syncResolve(key)
	if present {
		return v, true
	}
	if a.handle.isOptional(key) {
		return nil, false
	}
	panic(&ConfigKeyUnresolvedError{Key: key, Env: a.handle.environment, TriedTiers: tried})
}

// ContainerConfigHandle is returned by InitContainerConfig. It exposes the same
// tier accessors as the base config manager but with §3 fail-loud behavior,
// plus a non-throwing Health for Kubernetes readiness/liveness probes.
type ContainerConfigHandle struct {
	client      ConfigClient
	environment string
	cacheTTL    time.Duration
	optional    map[string]struct{}
	getEnv      func(string) string

	// PublicConfig / SecretConfig / FeatureFlag are the fail-loud accessors.
	PublicConfig tierAccessor
	SecretConfig tierAccessor
	FeatureFlag  tierAccessor

	mu          sync.Mutex
	lastFetchOK bool
	lastFetchAt time.Time
	lastError   string
}

// Client returns the underlying ConfigClient (escape hatch for advanced callers).
func (h *ContainerConfigHandle) Client() ConfigClient { return h.client }

func (h *ContainerConfigHandle) isOptional(key string) bool {
	_, ok := h.optional[key]
	return ok
}

// resolve reads a single key through the active container tiers: env override
// first (explicit process env wins, matching the existing chain's precedence),
// then the HTTP config server. Blob/file tiers are disabled (§2). present
// reports whether a non-absent value was found; tried lists the tiers consulted.
func (h *ContainerConfigHandle) resolve(key string) (value any, present bool, tried []Tier) {
	tried = append(tried, TierEnv)
	if fromEnv, ok := h.envOverride(key); ok {
		// Seed the cache so a later MustGet (sync read) sees the override too.
		h.client.SeedCache(key, fromEnv, h.environment)
		return fromEnv, true, tried
	}

	tried = append(tried, TierHTTP)
	v, err := h.client.GetValue(key, h.environment)
	if err != nil {
		h.recordError(err)
		// §5: serve last-good from cache until TTL hard-expiry.
		if cached, ok := h.client.GetCachedValue(key, h.environment); ok && isSet(cached) {
			log.Printf("@smooai/config (container): HTTP refresh failed for key %q; serving last-good cached value: %v", key, err)
			return cached, true, tried
		}
		return nil, false, tried
	}
	h.recordSuccess()
	if isSet(v) {
		return v, true, tried
	}
	return nil, false, tried
}

// syncResolve is the no-network read backing MustGet: env override then the
// local cache only.
func (h *ContainerConfigHandle) syncResolve(key string) (value any, present bool, tried []Tier) {
	tried = append(tried, TierEnv)
	if fromEnv, ok := h.envOverride(key); ok {
		return fromEnv, true, tried
	}
	tried = append(tried, TierHTTP)
	if cached, ok := h.client.GetCachedValue(key, h.environment); ok && isSet(cached) {
		return cached, true, tried
	}
	return nil, false, tried
}

// envOverride reads an explicit process env var for a key (UPPER_SNAKE_CASE of
// the camelCase key). A set-but-blank var counts as absent.
func (h *ContainerConfigHandle) envOverride(key string) (string, bool) {
	v := h.getEnv(envVarNameFor(key))
	if strings.TrimSpace(v) == "" {
		return "", false
	}
	return v, true
}

func (h *ContainerConfigHandle) recordSuccess() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.lastFetchOK = true
	h.lastFetchAt = time.Now()
	h.lastError = ""
}

func (h *ContainerConfigHandle) recordError(err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.lastError = err.Error()
}

// Health is a cheap, non-erroring status for readiness/liveness probes (§4). It
// serves "healthy" while within the cache TTL of the last good fetch even if a
// background refresh just failed; past the hard TTL a failed refresh flips it
// "unhealthy" (§5).
func (h *ContainerConfigHandle) Health() ConfigHealth {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.lastFetchOK {
		reason := h.lastError
		if reason == "" {
			reason = "initial config fetch has not succeeded"
		}
		return ConfigHealth{Status: "unhealthy", Reason: reason}
	}
	if h.lastError != "" && time.Since(h.lastFetchAt) > h.cacheTTL {
		return ConfigHealth{
			Status: "unhealthy",
			Reason: fmt.Sprintf("last config refresh failed and cache TTL (%s) expired: %s", h.cacheTTL, h.lastError),
		}
	}
	return ConfigHealth{Status: "healthy"}
}

// ConfigHealth is the free-function form of handle.Health (§4). Never errors or
// panics; a nil handle reports unhealthy.
func ConfigHealthOf(handle *ContainerConfigHandle) ConfigHealth {
	if handle == nil {
		return ConfigHealth{Status: "unhealthy", Reason: "nil config handle"}
	}
	return handle.Health()
}

type resolvedEnv struct {
	apiURL       string
	authURL      string
	clientID     string
	clientSecret string
	orgID        string
	environment  string
}

func resolveAndValidateEnv(opts InitContainerConfigOptions, getEnv func(string) string) (resolvedEnv, error) {
	pick := func(optVal string, envNames ...string) string {
		if v := strings.TrimSpace(optVal); v != "" {
			return optVal
		}
		for _, name := range envNames {
			if v := getEnv(name); strings.TrimSpace(v) != "" {
				return v
			}
		}
		return ""
	}

	authURL := pick(opts.AuthURL, "SMOOAI_CONFIG_AUTH_URL", "SMOOAI_AUTH_URL")
	if authURL == "" {
		authURL = "https://auth.smoo.ai"
	}

	env := resolvedEnv{
		apiURL:       pick(opts.APIURL, "SMOOAI_CONFIG_API_URL"),
		authURL:      authURL,
		clientID:     pick(opts.ClientID, "SMOOAI_CONFIG_CLIENT_ID"),
		clientSecret: pick(opts.ClientSecret, "SMOOAI_CONFIG_CLIENT_SECRET", "SMOOAI_CONFIG_API_KEY"),
		orgID:        pick(opts.OrgID, "SMOOAI_CONFIG_ORG_ID"),
		environment:  pick(opts.Environment, "SMOOAI_CONFIG_ENV"),
	}

	// When a ConfigClient is injected it already carries
	// apiURL/auth/clientID/secret/orgID — only the environment is still required.
	clientInjected := opts.ConfigClient != nil

	var missing []string
	if !clientInjected {
		if env.apiURL == "" {
			missing = append(missing, "SMOOAI_CONFIG_API_URL")
		}
		if env.clientID == "" {
			missing = append(missing, "SMOOAI_CONFIG_CLIENT_ID")
		}
		if env.clientSecret == "" {
			missing = append(missing, "SMOOAI_CONFIG_CLIENT_SECRET")
		}
		if env.orgID == "" {
			missing = append(missing, "SMOOAI_CONFIG_ORG_ID")
		}
	}
	if env.environment == "" {
		missing = append(missing, "SMOOAI_CONFIG_ENV")
	}
	if len(missing) > 0 {
		return resolvedEnv{}, &ConfigBootstrapError{Missing: missing}
	}
	return env, nil
}

// InitContainerConfig is the explicit container-mode bootstrap (§4). It
// validates the §1 env contract, constructs the M2M TokenProvider +
// ConfigClient, and performs an initial token mint + config fetch so
// auth/network failures surface at startup rather than on first read. The
// returned handle's accessors are fail-loud (§3).
//
// Returns a *ConfigBootstrapError when container-required env is missing/blank,
// or the underlying error on auth/network failure during the initial fetch.
func InitContainerConfig(ctx context.Context, opts InitContainerConfigOptions) (*ContainerConfigHandle, error) {
	if opts.Schema == nil {
		return nil, &ConfigBootstrapError{Missing: []string{"Schema"}}
	}

	getEnv := os.Getenv
	if opts.EnvOverride != nil {
		ov := opts.EnvOverride
		getEnv = func(k string) string { return ov[k] }
	}

	env, err := resolveAndValidateEnv(opts, getEnv)
	if err != nil {
		return nil, err
	}

	cacheTTL := opts.CacheTTL
	if cacheTTL <= 0 {
		cacheTTL = DefaultCacheTTL
	}
	refreshBuffer := opts.TokenRefreshBuffer
	if refreshBuffer <= 0 {
		refreshBuffer = DefaultTokenRefreshBufferSeconds
	}

	// Build the ConfigClient unless one is injected (test/embedding seam).
	var client ConfigClient
	if opts.ConfigClient != nil {
		client = opts.ConfigClient
	} else {
		clientOpts := []config.ConfigClientOption{
			config.WithCacheTTL(cacheTTL),
			config.WithAuthURL(env.authURL),
		}
		if opts.TokenProvider != nil {
			// The injected provider must be a *config.TokenProvider for
			// WithTokenProvider; if it's a different implementation, fall back
			// to constructing one from creds below.
			if tp, ok := opts.TokenProvider.(*config.TokenProvider); ok {
				clientOpts = append(clientOpts, config.WithTokenProvider(tp))
			}
		} else {
			tp, tpErr := config.NewTokenProvider(
				env.authURL, env.clientID, env.clientSecret,
				config.WithTokenProviderRefreshWindow(time.Duration(refreshBuffer)*time.Second),
			)
			if tpErr != nil {
				return nil, fmt.Errorf("@smooai/config (container): build token provider: %w", tpErr)
			}
			clientOpts = append(clientOpts, config.WithTokenProvider(tp))
		}
		client = config.NewConfigClient(env.apiURL, env.clientID, env.clientSecret, env.orgID, clientOpts...)
	}

	optional := make(map[string]struct{}, len(opts.OptionalKeys))
	for _, k := range opts.OptionalKeys {
		optional[k] = struct{}{}
	}

	handle := &ContainerConfigHandle{
		client:      client,
		environment: env.environment,
		cacheTTL:    cacheTTL,
		optional:    optional,
		getEnv:      getEnv,
	}
	handle.PublicConfig = tierAccessor{handle: handle, tier: "public"}
	handle.SecretConfig = tierAccessor{handle: handle, tier: "secret"}
	handle.FeatureFlag = tierAccessor{handle: handle, tier: "featureFlag"}

	// Initial config fetch — fail loud at startup, not first read. The OAuth
	// token mint happens inside GetAllValues (the ConfigClient's TokenProvider
	// exchanges on the first authed request), so an auth failure surfaces here
	// too. A pod that can't reach the config server should CrashLoop visibly,
	// not start degraded.
	if _, err := client.GetAllValues(env.environment); err != nil {
		handle.recordError(err)
		return nil, fmt.Errorf("@smooai/config (container): initial config fetch failed: %w", err)
	}
	handle.recordSuccess()

	return handle, nil
}

func isSet(v any) bool {
	if v == nil {
		return false
	}
	if s, ok := v.(string); ok {
		return s != ""
	}
	return true
}

// envVarNameFor converts a camelCase key to UPPER_SNAKE_CASE for env-var reads
// (matches the server tier and the TS implementation).
func envVarNameFor(key string) string {
	var b strings.Builder
	for _, r := range key {
		if r >= 'A' && r <= 'Z' {
			b.WriteByte('_')
		}
		b.WriteRune(r)
	}
	return strings.ToUpper(b.String())
}
