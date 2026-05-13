package config

// Integration tests for the Go config priority chain.
//
// Parity with TypeScript src/server/server.priority-chain.integration.test.ts,
// adapted to the Go architecture. Unlike the TS path (which merges
// blob → env → HTTP → file in one pipeline), the Go SDK splits the blob
// tier into a separate hydrator: NewRuntimeConfigManager decrypts the blob
// and installs it as the manager's "remote" tier in place of a live HTTP
// fetch. NewConfigManager (no blob) follows the 3-tier merge file < HTTP < env.
//
// Coverage:
//   - Each tier wins when higher tiers are absent (precedence)
//   - Tier missing entirely → nil (no crash)
//   - HTTP errors fall through to lower tiers (fault tolerance)
//   - Caching: repeated reads memoize; Invalidate() drops them
//   - Blob hydration: real AES-256-GCM blob is consumed by the manager
//     as the "remote" tier; env vars still win on top, file still
//     layers underneath.
//   - When a blob is present, no HTTP fetch happens for public/secret reads.

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ---------------------------------------------------------------------------
// Constants — match the TS reference
// ---------------------------------------------------------------------------

const (
	pcAPIKey = "test-api-key-priority-chain"
	pcOrgID  = "550e8400-e29b-41d4-a716-446655440000"
	pcEnv    = "production"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// pcMakeConfigDir writes a `.smooai-config/` dir with a single default.json.
func pcMakeConfigDir(t *testing.T, defaults map[string]any) string {
	t.Helper()
	dir := t.TempDir()
	configDir := filepath.Join(dir, ".smooai-config")
	require.NoError(t, os.MkdirAll(configDir, 0o755))
	b, err := json.Marshal(defaults)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(configDir, "default.json"), b, 0o644))
	return configDir
}

// pcHTTPServer mocks the Smoo AI config API. handlerFn is called for every
// request so tests can mutate the response between calls.
//
// SMOODEV-975: also handles the OAuth client_credentials handshake on
// POST /token. The /token traffic is NOT counted into hits (callers
// reason about config-fetch counts, not token mints).
func pcHTTPServer(t *testing.T, statusCode int, valuesByEnv map[string]map[string]any, hits *atomic.Int64) *httptest.Server {
	t.Helper()
	const pcMintedJWT = "pc-mock-jwt"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" && r.Method == http.MethodPost {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": pcMintedJWT,
				"expires_in":   3600,
			})
			return
		}
		if hits != nil {
			hits.Add(1)
		}
		// Auth check — runtime client carries the OAuth-minted JWT.
		if r.Header.Get("Authorization") != "Bearer "+pcMintedJWT {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "Unauthorized"})
			return
		}
		if statusCode != http.StatusOK {
			w.WriteHeader(statusCode)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "boom"})
			return
		}
		envName := r.URL.Query().Get("environment")
		if envName == "" {
			envName = "development"
		}
		envValues := valuesByEnv[envName]
		if envValues == nil {
			envValues = map[string]any{}
		}
		path := r.URL.Path
		base := "/organizations/" + pcOrgID + "/config/values"
		if strings.HasPrefix(path, base+"/") {
			key := strings.TrimPrefix(path, base+"/")
			val, ok := envValues[key]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": "Not found"})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"value": val})
			return
		}
		if path == base {
			_ = json.NewEncoder(w).Encode(map[string]any{"values": envValues})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// pcEncryptBlob writes a real AES-256-GCM blob using the same envelope as
// BuildBundle (nonce || ciphertext || tag).
func pcEncryptBlob(t *testing.T, dir string, payload partitionedBundle) (string, string) {
	t.Helper()
	plaintext, err := json.Marshal(payload)
	require.NoError(t, err)

	key := make([]byte, 32)
	_, err = io.ReadFull(rand.Reader, key)
	require.NoError(t, err)
	nonce := make([]byte, 12)
	_, err = io.ReadFull(rand.Reader, nonce)
	require.NoError(t, err)

	block, err := aes.NewCipher(key)
	require.NoError(t, err)
	gcm, err := cipher.NewGCM(block)
	require.NoError(t, err)
	blob := gcm.Seal(append([]byte(nil), nonce...), nonce, plaintext, nil)

	path := filepath.Join(dir, "smoo-config.enc")
	require.NoError(t, os.WriteFile(path, blob, 0o600))
	return path, base64.StdEncoding.EncodeToString(key)
}

// ---------------------------------------------------------------------------
// 3-tier merge: env > HTTP > file
// ---------------------------------------------------------------------------

func TestPriorityChain_EnvWinsOverHTTPAndFile(t *testing.T) {
	configDir := pcMakeConfigDir(t, map[string]any{"API_URL": "https://api.from-file.example"})
	srv := pcHTTPServer(t, http.StatusOK, map[string]map[string]any{
		pcEnv: {"API_URL": "https://api.from-http.example"},
	}, nil)

	mgr := NewConfigManager(
		WithAPIKey(pcAPIKey),
		WithBaseURL(srv.URL),
		WithOrgID(pcOrgID),
		WithConfigEnvironment(pcEnv),
		WithCMSchemaKeys(map[string]bool{"API_URL": true}),
		WithCMEnvOverride(map[string]string{
			"SMOOAI_CONFIG_AUTH_URL": srv.URL,
			"SMOOAI_ENV_CONFIG_DIR":  configDir,
			"SMOOAI_CONFIG_ENV":      pcEnv,
			"API_URL":                "https://api.from-env.example",
		}),
	)

	v, err := mgr.GetPublicConfig("API_URL")
	require.NoError(t, err)
	assert.Equal(t, "https://api.from-env.example", v)
}

func TestPriorityChain_HTTPWinsOverFileWhenEnvAbsent(t *testing.T) {
	configDir := pcMakeConfigDir(t, map[string]any{"API_URL": "https://api.from-file.example"})
	srv := pcHTTPServer(t, http.StatusOK, map[string]map[string]any{
		pcEnv: {"API_URL": "https://api.from-http.example"},
	}, nil)

	mgr := NewConfigManager(
		WithAPIKey(pcAPIKey),
		WithBaseURL(srv.URL),
		WithOrgID(pcOrgID),
		WithConfigEnvironment(pcEnv),
		WithCMEnvOverride(map[string]string{
			"SMOOAI_CONFIG_AUTH_URL": srv.URL,
			"SMOOAI_ENV_CONFIG_DIR":  configDir,
			"SMOOAI_CONFIG_ENV":      pcEnv,
		}),
	)

	v, err := mgr.GetPublicConfig("API_URL")
	require.NoError(t, err)
	assert.Equal(t, "https://api.from-http.example", v)
}

func TestPriorityChain_FileWinsWhenHTTPAndEnvAbsent(t *testing.T) {
	configDir := pcMakeConfigDir(t, map[string]any{"API_URL": "https://api.from-file.example"})

	mgr := NewConfigManager(
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     pcEnv,
		}),
	)

	v, err := mgr.GetPublicConfig("API_URL")
	require.NoError(t, err)
	assert.Equal(t, "https://api.from-file.example", v)
}

func TestPriorityChain_ReturnsNilWhenNoTierHasKey(t *testing.T) {
	configDir := pcMakeConfigDir(t, map[string]any{})

	mgr := NewConfigManager(
		WithCMEnvOverride(map[string]string{
			"SMOOAI_ENV_CONFIG_DIR": configDir,
			"SMOOAI_CONFIG_ENV":     pcEnv,
		}),
	)

	for _, tt := range []struct {
		name string
		fn   func(string) (any, error)
	}{
		{"public", mgr.GetPublicConfig},
		{"secret", mgr.GetSecretConfig},
		{"flag", mgr.GetFeatureFlag},
	} {
		t.Run(tt.name, func(t *testing.T) {
			v, err := tt.fn("MISSING_KEY")
			require.NoError(t, err)
			assert.Nil(t, v)
		})
	}
}

// ---------------------------------------------------------------------------
// HTTP fault tolerance
// ---------------------------------------------------------------------------

func TestPriorityChain_HTTP5xxFallsThroughToEnv(t *testing.T) {
	configDir := pcMakeConfigDir(t, map[string]any{})
	srv := pcHTTPServer(t, http.StatusInternalServerError, nil, nil)

	mgr := NewConfigManager(
		WithAPIKey(pcAPIKey),
		WithBaseURL(srv.URL),
		WithOrgID(pcOrgID),
		WithConfigEnvironment(pcEnv),
		WithCMSchemaKeys(map[string]bool{"API_URL": true}),
		WithCMEnvOverride(map[string]string{
			"SMOOAI_CONFIG_AUTH_URL": srv.URL,
			"SMOOAI_ENV_CONFIG_DIR":  configDir,
			"SMOOAI_CONFIG_ENV":      pcEnv,
			"API_URL":                "https://api.from-env.example",
		}),
	)

	v, err := mgr.GetPublicConfig("API_URL")
	require.NoError(t, err)
	assert.Equal(t, "https://api.from-env.example", v)
}

func TestPriorityChain_HTTP5xxFallsThroughToFile(t *testing.T) {
	configDir := pcMakeConfigDir(t, map[string]any{"API_URL": "https://api.from-file.example"})
	srv := pcHTTPServer(t, http.StatusServiceUnavailable, nil, nil)

	mgr := NewConfigManager(
		WithAPIKey(pcAPIKey),
		WithBaseURL(srv.URL),
		WithOrgID(pcOrgID),
		WithConfigEnvironment(pcEnv),
		WithCMEnvOverride(map[string]string{
			"SMOOAI_CONFIG_AUTH_URL": srv.URL,
			"SMOOAI_ENV_CONFIG_DIR":  configDir,
			"SMOOAI_CONFIG_ENV":      pcEnv,
		}),
	)

	v, err := mgr.GetPublicConfig("API_URL")
	require.NoError(t, err)
	assert.Equal(t, "https://api.from-file.example", v)
}

// ---------------------------------------------------------------------------
// Caching + invalidation
// ---------------------------------------------------------------------------

func TestPriorityChain_RepeatedReadsMemoizeUntilInvalidate(t *testing.T) {
	configDir := pcMakeConfigDir(t, map[string]any{})
	var hits atomic.Int64
	srv := pcHTTPServer(t, http.StatusOK, map[string]map[string]any{
		pcEnv: {"API_URL": "https://api.cached.example"},
	}, &hits)

	mgr := NewConfigManager(
		WithAPIKey(pcAPIKey),
		WithBaseURL(srv.URL),
		WithOrgID(pcOrgID),
		WithConfigEnvironment(pcEnv),
		WithCMEnvOverride(map[string]string{
			"SMOOAI_CONFIG_AUTH_URL": srv.URL,
			"SMOOAI_ENV_CONFIG_DIR":  configDir,
			"SMOOAI_CONFIG_ENV":      pcEnv,
		}),
	)

	v, err := mgr.GetPublicConfig("API_URL")
	require.NoError(t, err)
	assert.Equal(t, "https://api.cached.example", v)
	first := hits.Load()
	require.GreaterOrEqual(t, first, int64(1))

	// Second read should be cached — no new HTTP.
	v, err = mgr.GetPublicConfig("API_URL")
	require.NoError(t, err)
	assert.Equal(t, "https://api.cached.example", v)
	assert.Equal(t, first, hits.Load(), "cached read must not hit HTTP")

	// Invalidate forces re-init → HTTP again.
	mgr.Invalidate()
	v, err = mgr.GetPublicConfig("API_URL")
	require.NoError(t, err)
	assert.Equal(t, "https://api.cached.example", v)
	assert.Greater(t, hits.Load(), first, "invalidate must trigger a refetch")
}

// ---------------------------------------------------------------------------
// Blob hydration (NewRuntimeConfigManager) — separate path from live HTTP
// ---------------------------------------------------------------------------

func TestPriorityChain_BlobHydrationResolvesOffline(t *testing.T) {
	dir := t.TempDir()
	path, keyB64 := pcEncryptBlob(t, dir, partitionedBundle{
		Public: map[string]any{"apiUrl": "https://api.from-blob.example"},
		Secret: map[string]any{"sendgridApiKey": "SG.from-blob"},
	})

	// No BaseURL/APIKey/OrgID set — confirms we never attempt a network call.
	mgr, err := NewRuntimeConfigManager(RuntimeOptions{
		KeyFile: path,
		KeyB64:  keyB64,
		EnvOverride: map[string]string{
			"SMOOAI_CONFIG_ENV": pcEnv,
		},
	})
	require.NoError(t, err)

	pub, err := mgr.GetPublicConfig("apiUrl")
	require.NoError(t, err)
	assert.Equal(t, "https://api.from-blob.example", pub)

	sec, err := mgr.GetSecretConfig("sendgridApiKey")
	require.NoError(t, err)
	assert.Equal(t, "SG.from-blob", sec)
}

func TestPriorityChain_EnvOverridesBlob(t *testing.T) {
	// Even with a baked blob, an env var wins — matches TS env-over-remote.
	dir := t.TempDir()
	path, keyB64 := pcEncryptBlob(t, dir, partitionedBundle{
		Public: map[string]any{"API_URL": "https://api.from-blob.example"},
		Secret: map[string]any{},
	})

	mgr, err := NewRuntimeConfigManager(RuntimeOptions{
		KeyFile: path,
		KeyB64:  keyB64,
		EnvOverride: map[string]string{
			"API_URL": "https://api.from-env.example",
		},
		Extra: []ConfigManagerOption{
			WithCMSchemaKeys(map[string]bool{"API_URL": true}),
		},
	})
	require.NoError(t, err)

	v, err := mgr.GetPublicConfig("API_URL")
	require.NoError(t, err)
	assert.Equal(t, "https://api.from-env.example", v)
}

func TestPriorityChain_BlobBypassesHTTP(t *testing.T) {
	// Confirms the architectural split: when a blob is present, no HTTP
	// call happens for public/secret reads. Wire up an HTTP server that
	// would fail the test on any hit, then drive the manager.
	dir := t.TempDir()
	path, keyB64 := pcEncryptBlob(t, dir, partitionedBundle{
		Public: map[string]any{"apiUrl": "https://api.from-blob.example"},
		Secret: map[string]any{},
	})

	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)

	mgr, err := NewRuntimeConfigManager(RuntimeOptions{
		KeyFile: path,
		KeyB64:  keyB64,
		// Provide HTTP creds so the manager *would* fetch if the blob were
		// not consulted. The test asserts no HTTP hit.
		APIKey:      pcAPIKey,
		BaseURL:     srv.URL,
		OrgID:       pcOrgID,
		Environment: pcEnv,
	})
	require.NoError(t, err)

	v, err := mgr.GetPublicConfig("apiUrl")
	require.NoError(t, err)
	assert.Equal(t, "https://api.from-blob.example", v)
	assert.Equal(t, int64(0), hits.Load(), "blob path must not hit HTTP for public reads")
}
