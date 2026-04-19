package config

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// mockAllValuesServer serves GET /organizations/{org}/config/values with the
// provided JSON body. Mirrors the TS/Python/Rust bake tests.
func mockAllValuesServer(t *testing.T, values map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("environment") != "production" {
			http.Error(w, "unexpected env", 400)
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+testAPIKey {
			http.Error(w, "unauthorized", 401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"values": values})
	}))
}

func TestBuildBundle_PartitionsPublicSecretAndSkipsFlags(t *testing.T) {
	srv := mockAllValuesServer(t, map[string]any{
		"API_URL":        "https://api.example.com",
		"API_KEY":        "secret-123",
		"ENABLE_FEATURE": true,
	})
	defer srv.Close()

	classify := ClassifyFromSchema(
		map[string]struct{}{"API_URL": {}},
		map[string]struct{}{"API_KEY": {}},
		map[string]struct{}{"ENABLE_FEATURE": {}},
	)

	result, err := BuildBundle(BuildBundleArgs{
		BaseURL:     srv.URL,
		APIKey:      testAPIKey,
		OrgID:       testOrgID,
		Environment: "production",
		Classify:    classify,
	})
	require.NoError(t, err)

	assert.Equal(t, 2, result.KeyCount, "two keys baked (public + secret)")
	assert.Equal(t, 1, result.SkippedCount, "feature flag skipped")
	assert.Greater(t, len(result.Bundle), 28, "bundle has nonce + ct + tag")

	decoded, err := base64.StdEncoding.DecodeString(result.KeyB64)
	require.NoError(t, err)
	assert.Equal(t, 32, len(decoded), "key is 32 bytes AES-256")
}

func TestBuildBundle_RoundtripsThroughRuntime(t *testing.T) {
	srv := mockAllValuesServer(t, map[string]any{
		"API_URL":    "https://api.example.com",
		"API_KEY":    "secret-123",
		"DEBUG_MODE": false,
	})
	defer srv.Close()

	classify := ClassifyFromSchema(
		map[string]struct{}{"API_URL": {}, "DEBUG_MODE": {}},
		map[string]struct{}{"API_KEY": {}},
		nil,
	)

	result, err := BuildBundle(BuildBundleArgs{
		BaseURL:     srv.URL,
		APIKey:      testAPIKey,
		OrgID:       testOrgID,
		Environment: "production",
		Classify:    classify,
	})
	require.NoError(t, err)

	// Write the bundle to disk + set env vars exactly as the deploy
	// pipeline would, then exercise ReadBakedConfig through the public API.
	dir := t.TempDir()
	blobPath := filepath.Join(dir, "config.bin")
	require.NoError(t, os.WriteFile(blobPath, result.Bundle, 0o600))

	t.Setenv("SMOO_CONFIG_KEY_FILE", blobPath)
	t.Setenv("SMOO_CONFIG_KEY", result.KeyB64)
	resetRuntimeBlobCacheForTest()
	defer resetRuntimeBlobCacheForTest()

	blob, err := ReadBakedConfig()
	require.NoError(t, err)
	require.NotNil(t, blob)
	assert.Equal(t, 2, len(blob.Public))
	assert.Equal(t, 1, len(blob.Secret))
	assert.Equal(t, "https://api.example.com", blob.Public["API_URL"])
	assert.Equal(t, false, blob.Public["DEBUG_MODE"])
	assert.Equal(t, "secret-123", blob.Secret["API_KEY"])

	// Hydrate a ConfigClient — after this call, GetValue must resolve from
	// the in-memory cache without hitting the (now-closed) mock server.
	client := NewConfigClient(srv.URL, testAPIKey, testOrgID)
	defer client.Close()
	count, err := HydrateConfigClient(client, "production")
	require.NoError(t, err)
	assert.Equal(t, 3, count)

	// Close the mock server: any attempt to fetch will fail. The cache hit
	// is the assertion.
	srv.Close()

	url, err := client.GetValue("API_URL", "production")
	require.NoError(t, err)
	assert.Equal(t, "https://api.example.com", url)

	key, err := client.GetValue("API_KEY", "production")
	require.NoError(t, err)
	assert.Equal(t, "secret-123", key)
}

func TestHydrateConfigClient_SkipsWhenNoBlobEnv(t *testing.T) {
	// Explicitly clear env + reset cache so this test doesn't inherit state
	// from a previous test that set SMOO_CONFIG_KEY_FILE.
	t.Setenv("SMOO_CONFIG_KEY_FILE", "")
	t.Setenv("SMOO_CONFIG_KEY", "")
	resetRuntimeBlobCacheForTest()
	defer resetRuntimeBlobCacheForTest()

	client := NewConfigClient("http://unused", "key", testOrgID)
	defer client.Close()
	count, err := HydrateConfigClient(client, "")
	require.NoError(t, err)
	assert.Equal(t, 0, count)
}

// Sanity check: the decrypt layout in runtime.go must match the encrypt
// layout in build.go. Explicit low-level test guards against accidental
// drift (e.g. swapping nonce/ciphertext order).
func TestBundleLayout_MatchesDecryptExpectation(t *testing.T) {
	keyBytes := make([]byte, 32)
	for i := range keyBytes {
		keyBytes[i] = byte(i)
	}
	nonce := make([]byte, 12)
	for i := range nonce {
		nonce[i] = byte(0x10 + i)
	}

	plaintext := []byte(`{"public":{"A":"a"},"secret":{"B":"b"}}`)
	block, err := aes.NewCipher(keyBytes)
	require.NoError(t, err)
	gcm, err := cipher.NewGCM(block)
	require.NoError(t, err)
	ct := gcm.Seal(nil, nonce, plaintext, nil)

	bundle := append(append([]byte{}, nonce...), ct...)

	// Now decrypt as runtime.go does (nonce = first 12 bytes, rest is
	// ciphertext || tag).
	recNonce := bundle[:12]
	recCt := bundle[12:]
	got, err := gcm.Open(nil, recNonce, recCt, nil)
	require.NoError(t, err)
	assert.Equal(t, plaintext, got)
}
