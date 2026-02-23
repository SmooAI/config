package config

import (
	"fmt"
	"os"
	"sync"
	"time"
)

// ConfigManager is a unified config manager that merges three sources in this
// precedence (highest to lowest):
//
//  1. Env vars — always win
//  2. Remote API — authoritative values from server
//  3. File config — base defaults from JSON files
//
// Thread-safe via sync.Mutex. Lazy initialization loads all sources on first access.
// Per-key caches with configurable TTL for each tier (public, secret, feature_flag).
type ConfigManager struct {
	mu          sync.Mutex
	initialized bool
	config      map[string]any // single merged config

	// Per-tier caches
	publicCache map[string]localCacheEntry
	secretCache map[string]localCacheEntry
	ffCache     map[string]localCacheEntry

	// Local config params
	schemaKeys  map[string]bool
	envPrefix   string
	schemaTypes map[string]string
	cacheTTL    time.Duration
	envOverride map[string]string // for testing

	// Remote API params
	apiKey      string
	baseURL     string
	orgID       string
	environment string
}

// ConfigManagerOption is a functional option for ConfigManager.
type ConfigManagerOption func(*ConfigManager)

// NewConfigManager creates a new unified config manager with functional options.
func NewConfigManager(opts ...ConfigManagerOption) *ConfigManager {
	m := &ConfigManager{
		publicCache: make(map[string]localCacheEntry),
		secretCache: make(map[string]localCacheEntry),
		ffCache:     make(map[string]localCacheEntry),
		cacheTTL:    defaultLocalCacheTTL,
	}
	for _, opt := range opts {
		opt(m)
	}
	return m
}

// WithAPIKey sets the API key for remote config fetching.
func WithAPIKey(key string) ConfigManagerOption {
	return func(m *ConfigManager) { m.apiKey = key }
}

// WithBaseURL sets the base URL for the remote config API.
func WithBaseURL(url string) ConfigManagerOption {
	return func(m *ConfigManager) { m.baseURL = url }
}

// WithOrgID sets the organization ID for remote config fetching.
func WithOrgID(id string) ConfigManagerOption {
	return func(m *ConfigManager) { m.orgID = id }
}

// WithConfigEnvironment sets the environment name for remote config fetching.
func WithConfigEnvironment(env string) ConfigManagerOption {
	return func(m *ConfigManager) { m.environment = env }
}

// WithCMSchemaKeys sets schema keys for env config filtering.
func WithCMSchemaKeys(keys map[string]bool) ConfigManagerOption {
	return func(m *ConfigManager) { m.schemaKeys = keys }
}

// WithCMEnvPrefix sets env var prefix for stripping.
func WithCMEnvPrefix(prefix string) ConfigManagerOption {
	return func(m *ConfigManager) { m.envPrefix = prefix }
}

// WithCMSchemaTypes sets schema type hints for coercion.
func WithCMSchemaTypes(types map[string]string) ConfigManagerOption {
	return func(m *ConfigManager) { m.schemaTypes = types }
}

// WithCMCacheTTL sets the cache TTL.
func WithCMCacheTTL(ttl time.Duration) ConfigManagerOption {
	return func(m *ConfigManager) { m.cacheTTL = ttl }
}

// WithCMEnvOverride overrides environment variables (for testing).
func WithCMEnvOverride(env map[string]string) ConfigManagerOption {
	return func(m *ConfigManager) { m.envOverride = env }
}

// getEnvVal looks up a key from the env override map, falling back to os.Getenv.
func (m *ConfigManager) getEnvVal(key string) string {
	if m.envOverride != nil {
		return m.envOverride[key]
	}
	return os.Getenv(key)
}

func (m *ConfigManager) initialize() error {
	if m.initialized {
		return nil
	}

	// Resolve the env map for file/env config functions
	var env map[string]string
	if m.envOverride != nil {
		env = m.envOverride
	} else {
		env = osEnvMap()
	}

	// 1. Load file config (graceful — file config is optional)
	fileConfig, err := findAndProcessFileConfigWithEnv(env)
	if err != nil {
		fileConfig = make(map[string]any)
	}

	// 2. Load env config
	schemaKeys := m.schemaKeys
	if schemaKeys == nil {
		schemaKeys = make(map[string]bool)
	}
	envConfig := findAndProcessEnvConfigWithEnv(schemaKeys, m.envPrefix, m.schemaTypes, env)

	// 3. Try remote fetch if API creds are available
	remoteConfig := make(map[string]any)

	apiKey := m.apiKey
	baseURL := m.baseURL
	orgID := m.orgID

	// Check env vars as fallback for API credentials
	if apiKey == "" {
		apiKey = m.getEnvVal("SMOOAI_CONFIG_API_KEY")
	}
	if baseURL == "" {
		baseURL = m.getEnvVal("SMOOAI_CONFIG_API_URL")
	}
	if orgID == "" {
		orgID = m.getEnvVal("SMOOAI_CONFIG_ORG_ID")
	}

	if apiKey != "" && baseURL != "" && orgID != "" {
		// Resolve environment
		configEnv := m.environment
		if configEnv == "" {
			configEnv = m.getEnvVal("SMOOAI_CONFIG_ENV")
		}
		if configEnv == "" {
			configEnv = "development"
		}

		client := NewConfigClient(baseURL, apiKey, orgID)
		defer client.Close()

		values, err := client.GetAllValues(configEnv)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[Smooai Config] Warning: Failed to fetch remote config: %v\n", err)
		} else {
			remoteConfig = values
		}
	}

	// 4. Merge: file < remote < env
	merged := MergeReplaceArrays(make(map[string]any), fileConfig).(map[string]any)
	merged = MergeReplaceArrays(merged, remoteConfig).(map[string]any)
	merged = MergeReplaceArrays(merged, envConfig).(map[string]any)

	m.config = merged
	m.initialized = true
	return nil
}

func (m *ConfigManager) getFromTier(key string, cache map[string]localCacheEntry) (any, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Check cache
	if entry, ok := cache[key]; ok {
		if time.Now().Before(entry.expiresAt) {
			return entry.value, nil
		}
		delete(cache, key)
	}

	// Initialize if needed
	if err := m.initialize(); err != nil {
		return nil, err
	}

	// Lookup in merged config
	value := m.config[key]

	// Cache the result
	cache[key] = localCacheEntry{value: value, expiresAt: time.Now().Add(m.cacheTTL)}
	return value, nil
}

// GetPublicConfig retrieves a public config value.
func (m *ConfigManager) GetPublicConfig(key string) (any, error) {
	return m.getFromTier(key, m.publicCache)
}

// GetSecretConfig retrieves a secret config value.
func (m *ConfigManager) GetSecretConfig(key string) (any, error) {
	return m.getFromTier(key, m.secretCache)
}

// GetFeatureFlag retrieves a feature flag value.
func (m *ConfigManager) GetFeatureFlag(key string) (any, error) {
	return m.getFromTier(key, m.ffCache)
}

// Invalidate clears all caches and forces re-initialization on next access.
func (m *ConfigManager) Invalidate() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.initialized = false
	m.config = nil
	m.publicCache = make(map[string]localCacheEntry)
	m.secretCache = make(map[string]localCacheEntry)
	m.ffCache = make(map[string]localCacheEntry)
}
