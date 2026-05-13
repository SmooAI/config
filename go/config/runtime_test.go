package config

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
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// encryptSample writes an AES-256-GCM blob matching the BuildBundle layout
// (nonce || ciphertext || authTag) so tests can exercise the decrypt +
// hydrate path without standing up a network fetch first.
func encryptSample(t *testing.T, dir string, partitioned partitionedBundle) (string, string) {
	t.Helper()
	plaintext, err := json.Marshal(partitioned)
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

func TestNewRuntimeConfigManager_RoundTripHydratesCache(t *testing.T) {
	path, keyB64 := encryptSample(t, t.TempDir(), partitionedBundle{
		Public: map[string]any{"apiUrl": "https://api.example.com"},
		Secret: map[string]any{"tavilyApiKey": "tvly-abc"},
	})

	mgr, err := NewRuntimeConfigManager(RuntimeOptions{
		KeyFile: path,
		KeyB64:  keyB64,
		// Deliberately no APIKey/BaseURL/OrgID — a baked manager must
		// never need the network for public/secret reads.
		EnvOverride: map[string]string{
			"SMOOAI_CONFIG_ENV": "production",
		},
	})
	require.NoError(t, err)

	pub, err := mgr.GetPublicConfig("apiUrl")
	require.NoError(t, err)
	assert.Equal(t, "https://api.example.com", pub)

	sec, err := mgr.GetSecretConfig("tavilyApiKey")
	require.NoError(t, err)
	assert.Equal(t, "tvly-abc", sec)
}

func TestNewRuntimeConfigManager_WrongKeyRejects(t *testing.T) {
	path, _ := encryptSample(t, t.TempDir(), partitionedBundle{
		Public: map[string]any{"k": "v"},
		Secret: map[string]any{},
	})

	// Generate an unrelated 32-byte key.
	wrongKey := make([]byte, 32)
	_, err := io.ReadFull(rand.Reader, wrongKey)
	require.NoError(t, err)

	_, err = NewRuntimeConfigManager(RuntimeOptions{
		KeyFile: path,
		KeyB64:  base64.StdEncoding.EncodeToString(wrongKey),
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "decrypt")
}

func TestNewRuntimeConfigManager_TamperedBlobRejects(t *testing.T) {
	dir := t.TempDir()
	path, keyB64 := encryptSample(t, dir, partitionedBundle{
		Public: map[string]any{"k": "v"},
		Secret: map[string]any{},
	})

	// Flip one byte inside the ciphertext (past the 12-byte nonce prefix).
	blob, err := os.ReadFile(path)
	require.NoError(t, err)
	blob[20] ^= 0xff
	require.NoError(t, os.WriteFile(path, blob, 0o600))

	_, err = NewRuntimeConfigManager(RuntimeOptions{
		KeyFile: path,
		KeyB64:  keyB64,
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "decrypt")
}

func TestNewRuntimeConfigManager_ShortBlobRejects(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tiny.enc")
	require.NoError(t, os.WriteFile(path, []byte("too-short"), 0o600))

	key := make([]byte, 32)
	_, err := io.ReadFull(rand.Reader, key)
	require.NoError(t, err)

	_, err = NewRuntimeConfigManager(RuntimeOptions{
		KeyFile: path,
		KeyB64:  base64.StdEncoding.EncodeToString(key),
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "too short")
}

func TestNewRuntimeConfigManager_BadKeyLengthRejects(t *testing.T) {
	path, _ := encryptSample(t, t.TempDir(), partitionedBundle{
		Public: map[string]any{"k": "v"},
		Secret: map[string]any{},
	})

	_, err := NewRuntimeConfigManager(RuntimeOptions{
		KeyFile: path,
		KeyB64:  base64.StdEncoding.EncodeToString([]byte("short")),
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "32 bytes")
}

func TestNewRuntimeConfigManager_NoEnvFallsBackToLiveClient(t *testing.T) {
	// Without the blob env vars set, the runtime manager should behave
	// identically to a regular ConfigManager — proving GetPublicConfig
	// still resolves through the live fetch path.
	var hits atomic.Int64
	mux := http.NewServeMux()
	// SMOODEV-975: handle the OAuth handshake transparently — don't count.
	mux.HandleFunc("/token", func(w http.ResponseWriter, _ *http.Request) {
		require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
			"access_token": "stub-jwt",
			"expires_in":   3600,
		}))
	})
	mux.HandleFunc("/organizations/", func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
			"values": map[string]any{"liveKey": "live-value"},
		}))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	mgr, err := NewRuntimeConfigManager(RuntimeOptions{
		// No KeyFile/KeyB64 and no SMOO_CONFIG_* env — should fall back
		// cleanly to a live-fetching ConfigManager.
		APIKey:      "test-key",
		BaseURL:     srv.URL,
		OrgID:       "org-1",
		Environment: "production",
		EnvOverride: map[string]string{
			// Ensure no stray blob env vars leak in from the test runner.
			"SMOO_CONFIG_KEY_FILE": "",
			"SMOO_CONFIG_KEY":      "",
			// SMOODEV-975: route OAuth to the mock server.
			"SMOOAI_CONFIG_AUTH_URL": srv.URL,
		},
	})
	require.NoError(t, err)

	v, err := mgr.GetPublicConfig("liveKey")
	require.NoError(t, err)
	assert.Equal(t, "live-value", v)
	assert.GreaterOrEqual(t, hits.Load(), int64(1))
}

func TestNewRuntimeConfigManager_EnvVarsOverrideBakedValues(t *testing.T) {
	// Baked values must still be overridable by env vars — matches the
	// TS priority chain (env > remote/baked > file).
	path, keyB64 := encryptSample(t, t.TempDir(), partitionedBundle{
		Public: map[string]any{"API_URL": "https://baked.example.com"},
		Secret: map[string]any{},
	})

	mgr, err := NewRuntimeConfigManager(RuntimeOptions{
		KeyFile: path,
		KeyB64:  keyB64,
		EnvOverride: map[string]string{
			"API_URL": "https://env-wins.example.com",
		},
		Extra: []ConfigManagerOption{
			WithCMSchemaKeys(map[string]bool{"API_URL": true}),
		},
	})
	require.NoError(t, err)

	v, err := mgr.GetPublicConfig("API_URL")
	require.NoError(t, err)
	assert.Equal(t, "https://env-wins.example.com", v)
}

func TestNewRuntimeConfigManager_FeatureFlagsNotInBlob(t *testing.T) {
	// Feature flags are never baked into the blob — GetFeatureFlag for a
	// flag key that was skipped during BuildBundle returns nil from the
	// merged config.
	path, keyB64 := encryptSample(t, t.TempDir(), partitionedBundle{
		Public: map[string]any{"apiUrl": "https://api.example.com"},
		Secret: map[string]any{},
	})

	mgr, err := NewRuntimeConfigManager(RuntimeOptions{
		KeyFile: path,
		KeyB64:  keyB64,
	})
	require.NoError(t, err)

	flag, err := mgr.GetFeatureFlag("newFlow")
	require.NoError(t, err)
	assert.Nil(t, flag)
}
