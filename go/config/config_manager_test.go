package config

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// makeCMConfigDir creates a temp directory with config JSON files for testing.
func makeCMConfigDir(t *testing.T, files map[string]any) string {
	t.Helper()
	dir := t.TempDir()
	configDir := filepath.Join(dir, ".smooai-config")
	require.NoError(t, os.MkdirAll(configDir, 0o755))

	for name, content := range files {
		b, err := json.Marshal(content)
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(configDir, name), b, 0o644))
	}

	return configDir
}

// mockCMServer creates a mock config API server that returns the given values.
type mockCMServer struct {
	requestCount atomic.Int64
	server       *httptest.Server
	values       map[string]any
	apiKey       string
	orgID        string
}

func newMockCMServer(apiKey, orgID string, values map[string]any) *mockCMServer {
	m := &mockCMServer{
		values: values,
		apiKey: apiKey,
		orgID:  orgID,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/organizations/", func(w http.ResponseWriter, r *http.Request) {
		m.requestCount.Add(1)

		// Auth check
		auth := r.Header.Get("Authorization")
		if auth != "Bearer "+m.apiKey {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]string{"error": "Unauthorized"})
			return
		}

		// Return all values
		json.NewEncoder(w).Encode(map[string]any{"values": m.values})
	})

	m.server = httptest.NewServer(mux)
	return m
}

func (m *mockCMServer) close() {
	m.server.Close()
}

func (m *mockCMServer) count() int {
	return int(m.requestCount.Load())
}

func (m *mockCMServer) resetCount() {
	m.requestCount.Store(0)
}

// ---------------------------------------------------------------------------
// 1. Local-Only Mode — No API key, works like LocalConfigManager
// ---------------------------------------------------------------------------

func TestConfigManager_LocalOnlyMode(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"API_URL":      "http://localhost:3000",
			"MAX_RETRIES":  3,
			"ENABLE_DEBUG": true,
		},
	})

	mgr := NewConfigManager(
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
		}),
	)

	v, err := mgr.GetPublicConfig("API_URL")
	require.NoError(t, err)
	assert.Equal(t, "http://localhost:3000", v)

	v, err = mgr.GetPublicConfig("MAX_RETRIES")
	require.NoError(t, err)
	assert.Equal(t, 3.0, v) // JSON numbers are float64

	v, err = mgr.GetPublicConfig("ENABLE_DEBUG")
	require.NoError(t, err)
	assert.Equal(t, true, v)
}

func TestConfigManager_LocalOnlyMode_NoFileConfig(t *testing.T) {
	// When no config directory is found, file config is empty (graceful degradation)
	mgr := NewConfigManager(
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": "/nonexistent/path",
			"SMOOAI_CONFIG_ENV":     "test",
		}),
	)

	// Should still work — env config provides built-in keys
	v, err := mgr.GetPublicConfig("ENV")
	require.NoError(t, err)
	assert.Equal(t, "test", v)
}

func TestConfigManager_LocalOnlyMode_BuiltinKeys(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{"API_URL": "test"},
	})

	mgr := NewConfigManager(
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "production",
			"AWS_REGION":            "us-east-1",
		}),
	)

	v, _ := mgr.GetPublicConfig("ENV")
	assert.Equal(t, "production", v)

	v, _ = mgr.GetPublicConfig("IS_LOCAL")
	assert.Equal(t, false, v)

	v, _ = mgr.GetPublicConfig("CLOUD_PROVIDER")
	assert.Equal(t, "aws", v)

	v, _ = mgr.GetPublicConfig("REGION")
	assert.Equal(t, "us-east-1", v)
}

// ---------------------------------------------------------------------------
// 2. Remote Enrichment — Mock HTTP returns values, they appear in getters
// ---------------------------------------------------------------------------

func TestConfigManager_RemoteEnrichment(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"API_URL": "http://localhost:3000",
		},
	})

	mock := newMockCMServer("test-key", "test-org", map[string]any{
		"REMOTE_KEY":    "remote-value",
		"REMOTE_NUMBER": float64(42),
	})
	defer mock.close()

	mgr := NewConfigManager(
		WithAPIKey("test-key"),
		WithBaseURL(mock.server.URL),
		WithOrgID("test-org"),
		WithConfigEnvironment("production"),
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
		}),
	)

	v, err := mgr.GetPublicConfig("REMOTE_KEY")
	require.NoError(t, err)
	assert.Equal(t, "remote-value", v)

	v, err = mgr.GetPublicConfig("REMOTE_NUMBER")
	require.NoError(t, err)
	assert.Equal(t, float64(42), v)

	// File config values are still accessible
	v, err = mgr.GetPublicConfig("API_URL")
	require.NoError(t, err)
	assert.Equal(t, "http://localhost:3000", v)

	assert.Equal(t, 1, mock.count())
}

// ---------------------------------------------------------------------------
// 3. Merge Precedence — Same key in file + remote + env: env wins
// ---------------------------------------------------------------------------

func TestConfigManager_MergePrecedence_EnvWins(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"API_URL": "http://file-value",
		},
	})

	mock := newMockCMServer("test-key", "test-org", map[string]any{
		"API_URL": "http://remote-value",
	})
	defer mock.close()

	mgr := NewConfigManager(
		WithAPIKey("test-key"),
		WithBaseURL(mock.server.URL),
		WithOrgID("test-org"),
		WithConfigEnvironment("production"),
		WithCMSchemaKeys(map[string]bool{"API_URL": true}),
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
			"API_URL":               "http://env-value",
		}),
	)

	v, err := mgr.GetPublicConfig("API_URL")
	require.NoError(t, err)
	assert.Equal(t, "http://env-value", v)
}

func TestConfigManager_MergePrecedence_RemoteOverFile(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"API_URL": "http://file-value",
		},
	})

	mock := newMockCMServer("test-key", "test-org", map[string]any{
		"API_URL": "http://remote-value",
	})
	defer mock.close()

	mgr := NewConfigManager(
		WithAPIKey("test-key"),
		WithBaseURL(mock.server.URL),
		WithOrgID("test-org"),
		WithConfigEnvironment("production"),
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
			// No env var for API_URL, so remote should win over file
		}),
	)

	v, err := mgr.GetPublicConfig("API_URL")
	require.NoError(t, err)
	assert.Equal(t, "http://remote-value", v)
}

func TestConfigManager_MergePrecedence_FileIsBase(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"FILE_ONLY_KEY": "file-only-value",
		},
	})

	mock := newMockCMServer("test-key", "test-org", map[string]any{
		"REMOTE_ONLY_KEY": "remote-only-value",
	})
	defer mock.close()

	mgr := NewConfigManager(
		WithAPIKey("test-key"),
		WithBaseURL(mock.server.URL),
		WithOrgID("test-org"),
		WithConfigEnvironment("production"),
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
		}),
	)

	// File-only key is accessible
	v, err := mgr.GetPublicConfig("FILE_ONLY_KEY")
	require.NoError(t, err)
	assert.Equal(t, "file-only-value", v)

	// Remote-only key is also accessible
	v, err = mgr.GetPublicConfig("REMOTE_ONLY_KEY")
	require.NoError(t, err)
	assert.Equal(t, "remote-only-value", v)
}

// ---------------------------------------------------------------------------
// 4. Nested Object Merge — Remote partial override merges correctly
// ---------------------------------------------------------------------------

func TestConfigManager_NestedObjectMerge(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"DATABASE": map[string]any{
				"host": "localhost",
				"port": 5432,
				"ssl":  false,
			},
		},
	})

	mock := newMockCMServer("test-key", "test-org", map[string]any{
		"DATABASE": map[string]any{
			"host": "remote-db.example.com",
			"ssl":  true,
		},
	})
	defer mock.close()

	mgr := NewConfigManager(
		WithAPIKey("test-key"),
		WithBaseURL(mock.server.URL),
		WithOrgID("test-org"),
		WithConfigEnvironment("production"),
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
		}),
	)

	v, err := mgr.GetPublicConfig("DATABASE")
	require.NoError(t, err)
	db, ok := v.(map[string]any)
	require.True(t, ok)

	// Remote overrides host and ssl
	assert.Equal(t, "remote-db.example.com", db["host"])
	assert.Equal(t, true, db["ssl"])
	// File value for port is preserved
	assert.Equal(t, 5432.0, db["port"])
}

// ---------------------------------------------------------------------------
// 5. Graceful Degradation — Server returns 500, local config still works
// ---------------------------------------------------------------------------

func TestConfigManager_GracefulDegradation_Server500(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"API_URL": "http://localhost:3000",
		},
	})

	// Server that always returns 500
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": "Internal server error"})
	}))
	defer server.Close()

	mgr := NewConfigManager(
		WithAPIKey("test-key"),
		WithBaseURL(server.URL),
		WithOrgID("test-org"),
		WithConfigEnvironment("production"),
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
		}),
	)

	// Should still return file config values despite remote failure
	v, err := mgr.GetPublicConfig("API_URL")
	require.NoError(t, err)
	assert.Equal(t, "http://localhost:3000", v)
}

func TestConfigManager_GracefulDegradation_UnreachableServer(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"API_URL": "http://localhost:3000",
		},
	})

	mgr := NewConfigManager(
		WithAPIKey("test-key"),
		WithBaseURL("http://localhost:1"), // Unreachable port
		WithOrgID("test-org"),
		WithConfigEnvironment("production"),
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
		}),
	)

	// Should still return file config values
	v, err := mgr.GetPublicConfig("API_URL")
	require.NoError(t, err)
	assert.Equal(t, "http://localhost:3000", v)
}

// ---------------------------------------------------------------------------
// 6. Three Tiers Independent — Each tier has its own cache
// ---------------------------------------------------------------------------

func TestConfigManager_ThreeTiersIndependent(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"SHARED_KEY": "shared-value",
		},
	})

	mgr := NewConfigManager(
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
		}),
	)

	// Access the same key through all three tiers
	pub, err := mgr.GetPublicConfig("SHARED_KEY")
	require.NoError(t, err)
	assert.Equal(t, "shared-value", pub)

	sec, err := mgr.GetSecretConfig("SHARED_KEY")
	require.NoError(t, err)
	assert.Equal(t, "shared-value", sec)

	ff, err := mgr.GetFeatureFlag("SHARED_KEY")
	require.NoError(t, err)
	assert.Equal(t, "shared-value", ff)

	// Each tier has its own cache entry
	mgr.mu.Lock()
	assert.Contains(t, mgr.publicCache, "SHARED_KEY")
	assert.Contains(t, mgr.secretCache, "SHARED_KEY")
	assert.Contains(t, mgr.ffCache, "SHARED_KEY")
	mgr.mu.Unlock()
}

// ---------------------------------------------------------------------------
// 7. Cache Behavior — Second call cached, invalidate clears
// ---------------------------------------------------------------------------

func TestConfigManager_CacheBehavior_SecondCallCached(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"API_URL": "http://localhost:3000",
		},
	})

	mock := newMockCMServer("test-key", "test-org", map[string]any{
		"REMOTE_KEY": "remote-value",
	})
	defer mock.close()

	mgr := NewConfigManager(
		WithAPIKey("test-key"),
		WithBaseURL(mock.server.URL),
		WithOrgID("test-org"),
		WithConfigEnvironment("production"),
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
		}),
	)

	// First call triggers initialization and HTTP fetch
	v1, err := mgr.GetPublicConfig("REMOTE_KEY")
	require.NoError(t, err)
	assert.Equal(t, "remote-value", v1)
	assert.Equal(t, 1, mock.count())

	// Second call uses cache (no additional HTTP)
	v2, err := mgr.GetPublicConfig("REMOTE_KEY")
	require.NoError(t, err)
	assert.Equal(t, "remote-value", v2)
	assert.Equal(t, 1, mock.count()) // Still 1
}

func TestConfigManager_CacheBehavior_InvalidateClears(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"API_URL": "http://localhost:3000",
		},
	})

	mock := newMockCMServer("test-key", "test-org", map[string]any{
		"REMOTE_KEY": "remote-value",
	})
	defer mock.close()

	mgr := NewConfigManager(
		WithAPIKey("test-key"),
		WithBaseURL(mock.server.URL),
		WithOrgID("test-org"),
		WithConfigEnvironment("production"),
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
		}),
	)

	// First access
	_, err := mgr.GetPublicConfig("REMOTE_KEY")
	require.NoError(t, err)
	assert.Equal(t, 1, mock.count())

	// Invalidate
	mgr.Invalidate()

	// Verify caches are cleared
	mgr.mu.Lock()
	assert.Empty(t, mgr.publicCache)
	assert.Empty(t, mgr.secretCache)
	assert.Empty(t, mgr.ffCache)
	assert.False(t, mgr.initialized)
	assert.Nil(t, mgr.config)
	mgr.mu.Unlock()
}

func TestConfigManager_CacheBehavior_TTLExpiry(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"API_URL": "http://localhost:3000",
		},
	})

	mock := newMockCMServer("test-key", "test-org", map[string]any{
		"REMOTE_KEY": "remote-value",
	})
	defer mock.close()

	mgr := NewConfigManager(
		WithAPIKey("test-key"),
		WithBaseURL(mock.server.URL),
		WithOrgID("test-org"),
		WithConfigEnvironment("production"),
		WithCMCacheTTL(time.Millisecond), // Very short TTL
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
		}),
	)

	// First access
	v, err := mgr.GetPublicConfig("REMOTE_KEY")
	require.NoError(t, err)
	assert.Equal(t, "remote-value", v)

	// Wait for cache to expire
	time.Sleep(5 * time.Millisecond)

	// Second access — cache expired but config is already initialized,
	// so it re-reads from the same merged config (no new HTTP)
	v, err = mgr.GetPublicConfig("REMOTE_KEY")
	require.NoError(t, err)
	assert.Equal(t, "remote-value", v)

	// Only 1 HTTP call because initialize() short-circuits on m.initialized
	assert.Equal(t, 1, mock.count())
}

// ---------------------------------------------------------------------------
// 8. API Creds from Env — Set env vars, auto-detected
// ---------------------------------------------------------------------------

func TestConfigManager_APICredsFromEnv(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"BASE_KEY": "base-value",
		},
	})

	mock := newMockCMServer("env-api-key", "env-org-id", map[string]any{
		"REMOTE_KEY": "from-env-creds",
	})
	defer mock.close()

	mgr := NewConfigManager(
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
			"SMOOAI_CONFIG_API_KEY": "env-api-key",
			"SMOOAI_CONFIG_API_URL": mock.server.URL,
			"SMOOAI_CONFIG_ORG_ID":  "env-org-id",
		}),
	)

	v, err := mgr.GetPublicConfig("REMOTE_KEY")
	require.NoError(t, err)
	assert.Equal(t, "from-env-creds", v)
	assert.Equal(t, 1, mock.count())
}

// ---------------------------------------------------------------------------
// 9. API Creds from Constructor — Direct params override env
// ---------------------------------------------------------------------------

func TestConfigManager_APICredsFromConstructor(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"BASE_KEY": "base-value",
		},
	})

	mock := newMockCMServer("constructor-key", "constructor-org", map[string]any{
		"REMOTE_KEY": "from-constructor",
	})
	defer mock.close()

	mgr := NewConfigManager(
		WithAPIKey("constructor-key"),
		WithBaseURL(mock.server.URL),
		WithOrgID("constructor-org"),
		WithConfigEnvironment("production"),
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
			// These env creds should be ignored since constructor params are set
			"SMOOAI_CONFIG_API_KEY": "env-key-should-be-ignored",
			"SMOOAI_CONFIG_API_URL": "http://env-url-should-be-ignored",
			"SMOOAI_CONFIG_ORG_ID":  "env-org-should-be-ignored",
		}),
	)

	v, err := mgr.GetPublicConfig("REMOTE_KEY")
	require.NoError(t, err)
	assert.Equal(t, "from-constructor", v)
	assert.Equal(t, 1, mock.count())
}

// ---------------------------------------------------------------------------
// 10. Thread Safety — Multiple goroutines concurrent access
// ---------------------------------------------------------------------------

func TestConfigManager_ThreadSafety_ConcurrentReads(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"API_URL":   "http://localhost:3000",
			"MAX_RETRY": 3,
		},
	})

	mock := newMockCMServer("test-key", "test-org", map[string]any{
		"REMOTE_KEY": "remote-value",
	})
	defer mock.close()

	mgr := NewConfigManager(
		WithAPIKey("test-key"),
		WithBaseURL(mock.server.URL),
		WithOrgID("test-org"),
		WithConfigEnvironment("production"),
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
		}),
	)

	var wg sync.WaitGroup
	const goroutines = 20

	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v, err := mgr.GetPublicConfig("REMOTE_KEY")
			assert.NoError(t, err)
			assert.Equal(t, "remote-value", v)
		}()
	}
	wg.Wait()

	// Only 1 HTTP call despite concurrent access
	assert.Equal(t, 1, mock.count())
}

func TestConfigManager_ThreadSafety_ConcurrentInvalidateAndRead(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"API_URL": "http://localhost:3000",
		},
	})

	mock := newMockCMServer("test-key", "test-org", map[string]any{
		"REMOTE_KEY": "remote-value",
	})
	defer mock.close()

	mgr := NewConfigManager(
		WithAPIKey("test-key"),
		WithBaseURL(mock.server.URL),
		WithOrgID("test-org"),
		WithConfigEnvironment("production"),
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
		}),
	)

	// Pre-populate
	_, err := mgr.GetPublicConfig("REMOTE_KEY")
	require.NoError(t, err)

	// Concurrent invalidate + reads should not panic
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			mgr.Invalidate()
		}()
		go func() {
			defer wg.Done()
			_, _ = mgr.GetPublicConfig("REMOTE_KEY")
		}()
	}
	wg.Wait()
}

func TestConfigManager_ThreadSafety_ConcurrentMultiTier(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"KEY": "value",
		},
	})

	mgr := NewConfigManager(
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
		}),
	)

	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(3)
		go func() {
			defer wg.Done()
			v, err := mgr.GetPublicConfig("KEY")
			assert.NoError(t, err)
			assert.Equal(t, "value", v)
		}()
		go func() {
			defer wg.Done()
			v, err := mgr.GetSecretConfig("KEY")
			assert.NoError(t, err)
			assert.Equal(t, "value", v)
		}()
		go func() {
			defer wg.Done()
			v, err := mgr.GetFeatureFlag("KEY")
			assert.NoError(t, err)
			assert.Equal(t, "value", v)
		}()
	}
	wg.Wait()
}

// ---------------------------------------------------------------------------
// 11. Full Integration — Temp config dir + mock HTTP + env overrides
// ---------------------------------------------------------------------------

func TestConfigManager_FullIntegration(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"API_URL":          "http://localhost:3000",
			"MAX_RETRIES":      3,
			"DATABASE":         map[string]any{"host": "localhost", "port": 5432, "ssl": false},
			"FILE_ONLY":        "from-file",
			"ENABLE_NEW_UI":    false,
			"MAINTENANCE_MODE": false,
		},
		"production.json": map[string]any{
			"API_URL":     "https://api.production.com",
			"MAX_RETRIES": 5,
			"DATABASE":    map[string]any{"host": "prod-db.example.com", "ssl": true},
		},
	})

	mock := newMockCMServer("test-key", "test-org", map[string]any{
		"API_URL":       "https://api.remote.com",
		"REMOTE_SECRET": "secret-from-remote",
		"ENABLE_NEW_UI": true,
	})
	defer mock.close()

	mgr := NewConfigManager(
		WithAPIKey("test-key"),
		WithBaseURL(mock.server.URL),
		WithOrgID("test-org"),
		WithConfigEnvironment("production"),
		WithCMSchemaKeys(map[string]bool{"API_URL": true, "MAX_RETRIES": true}),
		WithCMSchemaTypes(map[string]string{"MAX_RETRIES": "number"}),
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "production",
			"MAX_RETRIES":           "10",
		}),
	)

	// API_URL: file=production (https://api.production.com), remote=https://api.remote.com, env=set in schemaKeys
	// Remote overrides file, but env schema has API_URL
	v, err := mgr.GetPublicConfig("API_URL")
	require.NoError(t, err)
	// env config includes API_URL since it's in schemaKeys, but the env map doesn't have API_URL set
	// So merge: file(production.json)="https://api.production.com" < remote="https://api.remote.com" < env(no API_URL val)
	// Remote wins
	assert.Equal(t, "https://api.remote.com", v)

	// MAX_RETRIES: file=5, remote=not set, env="10" (coerced to int 10)
	v, err = mgr.GetPublicConfig("MAX_RETRIES")
	require.NoError(t, err)
	assert.Equal(t, 10, v) // env wins, coerced to int via schemaTypes

	// FILE_ONLY: only in file config
	v, err = mgr.GetPublicConfig("FILE_ONLY")
	require.NoError(t, err)
	assert.Equal(t, "from-file", v)

	// REMOTE_SECRET: only from remote
	v, err = mgr.GetSecretConfig("REMOTE_SECRET")
	require.NoError(t, err)
	assert.Equal(t, "secret-from-remote", v)

	// ENABLE_NEW_UI: file=false, remote=true
	v, err = mgr.GetFeatureFlag("ENABLE_NEW_UI")
	require.NoError(t, err)
	assert.Equal(t, true, v) // Remote overrides file

	// MAINTENANCE_MODE: only in file (default.json)
	v, err = mgr.GetFeatureFlag("MAINTENANCE_MODE")
	require.NoError(t, err)
	assert.Equal(t, false, v)

	// DATABASE: file merges default + production, remote doesn't override
	v, err = mgr.GetPublicConfig("DATABASE")
	require.NoError(t, err)
	db := v.(map[string]any)
	assert.Equal(t, "prod-db.example.com", db["host"])
	assert.Equal(t, true, db["ssl"])
	assert.Equal(t, 5432.0, db["port"])
}

// ---------------------------------------------------------------------------
// 12. Environment Resolution — Explicit > env var > default
// ---------------------------------------------------------------------------

func TestConfigManager_EnvironmentResolution_Explicit(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{"KEY": "val"},
	})

	var receivedEnv string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedEnv = r.URL.Query().Get("environment")
		json.NewEncoder(w).Encode(map[string]any{"values": map[string]any{}})
	}))
	defer server.Close()

	mgr := NewConfigManager(
		WithAPIKey("key"),
		WithBaseURL(server.URL),
		WithOrgID("org"),
		WithConfigEnvironment("explicit-env"),
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "env-var-env",
		}),
	)

	_, _ = mgr.GetPublicConfig("KEY")
	assert.Equal(t, "explicit-env", receivedEnv)
}

func TestConfigManager_EnvironmentResolution_EnvVar(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{"KEY": "val"},
	})

	var receivedEnv string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedEnv = r.URL.Query().Get("environment")
		json.NewEncoder(w).Encode(map[string]any{"values": map[string]any{}})
	}))
	defer server.Close()

	mgr := NewConfigManager(
		WithAPIKey("key"),
		WithBaseURL(server.URL),
		WithOrgID("org"),
		// No WithConfigEnvironment — should fall back to env var
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "from-env-var",
		}),
	)

	_, _ = mgr.GetPublicConfig("KEY")
	assert.Equal(t, "from-env-var", receivedEnv)
}

func TestConfigManager_EnvironmentResolution_Default(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{"KEY": "val"},
	})

	var receivedEnv string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedEnv = r.URL.Query().Get("environment")
		json.NewEncoder(w).Encode(map[string]any{"values": map[string]any{}})
	}))
	defer server.Close()

	mgr := NewConfigManager(
		WithAPIKey("key"),
		WithBaseURL(server.URL),
		WithOrgID("org"),
		// No WithConfigEnvironment, no SMOOAI_CONFIG_ENV — should default to "development"
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
		}),
	)

	_, _ = mgr.GetPublicConfig("KEY")
	assert.Equal(t, "development", receivedEnv)
}

// ---------------------------------------------------------------------------
// 13. Invalidation Re-fetches — Invalidate then getter triggers new HTTP
// ---------------------------------------------------------------------------

func TestConfigManager_InvalidationRefetches(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"BASE_KEY": "base-value",
		},
	})

	callCount := 0
	returnValue := "first-value"
	var mu sync.Mutex

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		callCount++
		val := returnValue
		mu.Unlock()
		json.NewEncoder(w).Encode(map[string]any{
			"values": map[string]any{"REMOTE_KEY": val},
		})
	}))
	defer server.Close()

	mgr := NewConfigManager(
		WithAPIKey("key"),
		WithBaseURL(server.URL),
		WithOrgID("org"),
		WithConfigEnvironment("production"),
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
		}),
	)

	// First access
	v, err := mgr.GetPublicConfig("REMOTE_KEY")
	require.NoError(t, err)
	assert.Equal(t, "first-value", v)
	mu.Lock()
	assert.Equal(t, 1, callCount)
	mu.Unlock()

	// Change server response
	mu.Lock()
	returnValue = "second-value"
	mu.Unlock()

	// Second access without invalidate — cached
	v, err = mgr.GetPublicConfig("REMOTE_KEY")
	require.NoError(t, err)
	assert.Equal(t, "first-value", v)
	mu.Lock()
	assert.Equal(t, 1, callCount) // No new HTTP call
	mu.Unlock()

	// Invalidate
	mgr.Invalidate()

	// Third access — re-initializes and fetches new value
	v, err = mgr.GetPublicConfig("REMOTE_KEY")
	require.NoError(t, err)
	assert.Equal(t, "second-value", v)
	mu.Lock()
	assert.Equal(t, 2, callCount) // New HTTP call after invalidation
	mu.Unlock()
}

// ---------------------------------------------------------------------------
// Additional edge case tests
// ---------------------------------------------------------------------------

func TestConfigManager_NonexistentKey(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"API_URL": "http://localhost:3000",
		},
	})

	mgr := NewConfigManager(
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
		}),
	)

	v, err := mgr.GetPublicConfig("nonexistent")
	require.NoError(t, err)
	assert.Nil(t, v)
}

func TestConfigManager_DefaultOptions(t *testing.T) {
	// Verify defaults are set correctly
	mgr := NewConfigManager()

	assert.NotNil(t, mgr.publicCache)
	assert.NotNil(t, mgr.secretCache)
	assert.NotNil(t, mgr.ffCache)
	assert.Equal(t, defaultLocalCacheTTL, mgr.cacheTTL)
	assert.False(t, mgr.initialized)
	assert.Empty(t, mgr.apiKey)
	assert.Empty(t, mgr.baseURL)
	assert.Empty(t, mgr.orgID)
	assert.Empty(t, mgr.environment)
}

func TestConfigManager_PartialAPICreds_NoRemoteFetch(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"API_URL": "http://localhost:3000",
		},
	})

	// Only API key set, no base URL or org ID — should skip remote fetch
	mgr := NewConfigManager(
		WithAPIKey("test-key"),
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
		}),
	)

	v, err := mgr.GetPublicConfig("API_URL")
	require.NoError(t, err)
	assert.Equal(t, "http://localhost:3000", v)
}

func TestConfigManager_EnvPrefixStripping(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"API_URL": "from-file",
		},
	})

	mgr := NewConfigManager(
		WithCMSchemaKeys(map[string]bool{"API_URL": true}),
		WithCMEnvPrefix("NEXT_PUBLIC_"),
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
			"NEXT_PUBLIC_API_URL":   "from-env-with-prefix",
		}),
	)

	v, err := mgr.GetPublicConfig("API_URL")
	require.NoError(t, err)
	assert.Equal(t, "from-env-with-prefix", v) // env wins
}

func TestConfigManager_SchemaTypeCoercion(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"MAX_RETRIES": 3,
		},
	})

	mgr := NewConfigManager(
		WithCMSchemaKeys(map[string]bool{"MAX_RETRIES": true, "ENABLE_DEBUG": true}),
		WithCMSchemaTypes(map[string]string{
			"MAX_RETRIES":  "number",
			"ENABLE_DEBUG": "boolean",
		}),
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
			"MAX_RETRIES":           "10",
			"ENABLE_DEBUG":          "true",
		}),
	)

	v, err := mgr.GetPublicConfig("MAX_RETRIES")
	require.NoError(t, err)
	assert.Equal(t, 10, v) // Coerced from string "10" to int

	v, err = mgr.GetPublicConfig("ENABLE_DEBUG")
	require.NoError(t, err)
	assert.Equal(t, true, v) // Coerced from string "true" to bool
}

// ---------------------------------------------------------------------------
// Deferred (Computed) Config Values
// ---------------------------------------------------------------------------

func TestConfigManager_DeferredBasic(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"HOST": "localhost",
			"PORT": float64(5432),
		},
	})

	mgr := NewConfigManager(
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
		}),
		WithDeferred("FULL_URL", func(config map[string]any) any {
			host, _ := config["HOST"].(string)
			port := config["PORT"]
			return fmt.Sprintf("%s:%v", host, port)
		}),
	)

	v, err := mgr.GetPublicConfig("FULL_URL")
	require.NoError(t, err)
	assert.Equal(t, "localhost:5432", v)

	// Original values preserved
	v, err = mgr.GetPublicConfig("HOST")
	require.NoError(t, err)
	assert.Equal(t, "localhost", v)

	v, err = mgr.GetPublicConfig("PORT")
	require.NoError(t, err)
	assert.Equal(t, 5432.0, v)
}

func TestConfigManager_DeferredMultipleSeeSnapshot(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"BASE": "hello",
		},
	})

	mgr := NewConfigManager(
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
		}),
		WithDeferred("A", func(config map[string]any) any {
			base, _ := config["BASE"].(string)
			return base + "-a"
		}),
		WithDeferred("B", func(config map[string]any) any {
			_, hasA := config["A"]
			return hasA
		}),
	)

	v, err := mgr.GetPublicConfig("A")
	require.NoError(t, err)
	assert.Equal(t, "hello-a", v)

	// B should see that A was NOT in the snapshot
	v, err = mgr.GetPublicConfig("B")
	require.NoError(t, err)
	assert.Equal(t, false, v)
}

func TestConfigManager_DeferredRunsAfterMerge(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"HOST": "file-host",
		},
	})

	mgr := NewConfigManager(
		WithCMSchemaKeys(map[string]bool{"HOST": true}),
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
			"HOST":                  "env-host",
		}),
		WithDeferred("API_URL", func(config map[string]any) any {
			host, _ := config["HOST"].(string)
			return fmt.Sprintf("https://%s/api", host)
		}),
	)

	// Env overrides file, deferred sees env value
	v, err := mgr.GetPublicConfig("API_URL")
	require.NoError(t, err)
	assert.Equal(t, "https://env-host/api", v)
}

func TestConfigManager_DeferredWithRemote(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"HOST": "file-host",
		},
	})

	mock := newMockCMServer("key", "org", map[string]any{
		"HOST": "remote-host",
		"PORT": float64(8080),
	})
	defer mock.close()

	mgr := NewConfigManager(
		WithAPIKey("key"),
		WithBaseURL(mock.server.URL),
		WithOrgID("org"),
		WithConfigEnvironment("test"),
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "test",
		}),
		WithDeferred("FULL_URL", func(config map[string]any) any {
			host, _ := config["HOST"].(string)
			port := config["PORT"]
			return fmt.Sprintf("%s:%v", host, port)
		}),
	)

	v, err := mgr.GetPublicConfig("FULL_URL")
	require.NoError(t, err)
	assert.Equal(t, "remote-host:8080", v)
}

func TestConfigManager_FileConfigMergeChain(t *testing.T) {
	configDir := makeCMConfigDir(t, map[string]any{
		"default.json": map[string]any{
			"API_URL":     "http://localhost:3000",
			"MAX_RETRIES": 3,
			"DATABASE":    map[string]any{"host": "localhost", "port": 5432, "ssl": false},
		},
		"production.json": map[string]any{
			"API_URL":     "https://api.prod.com",
			"MAX_RETRIES": 5,
			"DATABASE":    map[string]any{"host": "prod-db.com", "ssl": true},
		},
		"production.aws.json": map[string]any{
			"API_URL":  "https://aws-api.prod.com",
			"DATABASE": map[string]any{"host": "aws-prod-db.com"},
		},
		"production.aws.us-east-1.json": map[string]any{
			"DATABASE": map[string]any{"host": "us-east-1-db.com"},
		},
	})

	mgr := NewConfigManager(
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     "production",
			"AWS_REGION":            "us-east-1",
		}),
	)

	v, _ := mgr.GetPublicConfig("API_URL")
	assert.Equal(t, "https://aws-api.prod.com", v)

	v, _ = mgr.GetPublicConfig("MAX_RETRIES")
	assert.Equal(t, 5.0, v)

	v, _ = mgr.GetPublicConfig("DATABASE")
	db := v.(map[string]any)
	assert.Equal(t, "us-east-1-db.com", db["host"])
	assert.Equal(t, true, db["ssl"])
	assert.Equal(t, 5432.0, db["port"])
}
