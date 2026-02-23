package config

import (
	"sync"
	"time"
)

const defaultLocalCacheTTL = 24 * time.Hour

type localCacheEntry struct {
	value     any
	expiresAt time.Time
}

// LocalConfigManager provides lazy-initialized, cached config access.
//
// Thread-safe via sync.Mutex. Lazy initialization loads file config + env config on first access.
// Per-key caches with 24h TTL for each tier (public, secret, feature_flag).
// File config takes precedence over env config.
type LocalConfigManager struct {
	mu          sync.Mutex
	initialized bool
	fileConfig  map[string]any
	envConfig   map[string]any
	publicCache map[string]localCacheEntry
	secretCache map[string]localCacheEntry
	ffCache     map[string]localCacheEntry
	schemaKeys  map[string]bool
	envPrefix   string
	schemaTypes map[string]string
	cacheTTL    time.Duration
	envOverride map[string]string
}

// LocalConfigOption is a functional option for LocalConfigManager.
type LocalConfigOption func(*LocalConfigManager)

// NewLocalConfigManager creates a new manager with functional options.
func NewLocalConfigManager(opts ...LocalConfigOption) *LocalConfigManager {
	m := &LocalConfigManager{
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

// WithSchemaKeys sets schema keys for env config filtering.
func WithSchemaKeys(keys map[string]bool) LocalConfigOption {
	return func(m *LocalConfigManager) { m.schemaKeys = keys }
}

// WithEnvPrefix sets env var prefix for stripping.
func WithEnvPrefix(prefix string) LocalConfigOption {
	return func(m *LocalConfigManager) { m.envPrefix = prefix }
}

// WithSchemaTypes sets schema type hints for coercion.
func WithSchemaTypes(types map[string]string) LocalConfigOption {
	return func(m *LocalConfigManager) { m.schemaTypes = types }
}

// WithLocalCacheTTL sets the cache TTL.
func WithLocalCacheTTL(ttl time.Duration) LocalConfigOption {
	return func(m *LocalConfigManager) { m.cacheTTL = ttl }
}

// WithEnvOverride overrides environment variables (for testing).
func WithEnvOverride(env map[string]string) LocalConfigOption {
	return func(m *LocalConfigManager) { m.envOverride = env }
}

func (m *LocalConfigManager) getEnv() map[string]string {
	if m.envOverride != nil {
		return m.envOverride
	}
	return osEnvMap()
}

func (m *LocalConfigManager) initialize() error {
	if m.initialized {
		return nil
	}

	env := m.getEnv()

	fileConfig, err := findAndProcessFileConfigWithEnv(env)
	if err != nil {
		return err
	}
	m.fileConfig = fileConfig

	schemaKeys := m.schemaKeys
	if schemaKeys == nil {
		schemaKeys = make(map[string]bool)
	}
	m.envConfig = findAndProcessEnvConfigWithEnv(schemaKeys, m.envPrefix, m.schemaTypes, env)
	m.initialized = true
	return nil
}

func (m *LocalConfigManager) getValue(key string, cache map[string]localCacheEntry) (any, error) {
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

	// File config takes precedence
	if m.fileConfig != nil {
		if v, ok := m.fileConfig[key]; ok {
			cache[key] = localCacheEntry{value: v, expiresAt: time.Now().Add(m.cacheTTL)}
			return v, nil
		}
	}

	// Env config fallback
	if m.envConfig != nil {
		if v, ok := m.envConfig[key]; ok {
			cache[key] = localCacheEntry{value: v, expiresAt: time.Now().Add(m.cacheTTL)}
			return v, nil
		}
	}

	return nil, nil
}

// GetPublicConfig retrieves a public config value.
func (m *LocalConfigManager) GetPublicConfig(key string) (any, error) {
	return m.getValue(key, m.publicCache)
}

// GetSecretConfig retrieves a secret config value.
func (m *LocalConfigManager) GetSecretConfig(key string) (any, error) {
	return m.getValue(key, m.secretCache)
}

// GetFeatureFlag retrieves a feature flag value.
func (m *LocalConfigManager) GetFeatureFlag(key string) (any, error) {
	return m.getValue(key, m.ffCache)
}

// Invalidate clears all caches and forces re-initialization on next access.
func (m *LocalConfigManager) Invalidate() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.initialized = false
	m.fileConfig = nil
	m.envConfig = nil
	m.publicCache = make(map[string]localCacheEntry)
	m.secretCache = make(map[string]localCacheEntry)
	m.ffCache = make(map[string]localCacheEntry)
}
