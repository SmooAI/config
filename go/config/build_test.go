package config

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// mockBuildServer serves a fixed map of values from GetAllValues so
// BuildBundle can exercise its fetch + encrypt path without touching a
// real config API.
//
// SMOODEV-975: also handles the OAuth client_credentials handshake on
// POST /token. The runtime ConfigClient calls the OAuth endpoint first
// to mint a JWT; the validator on /organizations/ then checks against
// the minted "build-mock-jwt" token rather than the raw apiKey.
//
// Tests still pass the apiKey to BuildBundle (it's the OAuth client_secret
// in disguise); when apiKey is set to a value the server doesn't recognize,
// the /token endpoint refuses to mint, which surfaces as the same
// "config build bundle fetch" error path. See TestBuildBundle_RemoteFetchError.
func mockBuildServer(t *testing.T, apiKey string, values map[string]any) *httptest.Server {
	t.Helper()
	const mintedJWT = "build-mock-jwt"
	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		// Refuse to mint when the credentials don't match the test setup.
		// Read the form data to check.
		if err := r.ParseForm(); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.PostFormValue("client_secret") != apiKey {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
			"access_token": mintedJWT,
			"expires_in":   3600,
		}))
	})
	mux.HandleFunc("/organizations/", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+mintedJWT {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		require.NoError(t, json.NewEncoder(w).Encode(map[string]any{"values": values}))
	})
	return httptest.NewServer(mux)
}

// decryptBundleForTest inverts the AES-256-GCM seal in BuildBundle so
// tests can inspect the plaintext without invoking the runtime loader.
func decryptBundleForTest(t *testing.T, blob []byte, keyB64 string) partitionedBundle {
	t.Helper()
	key, err := base64.StdEncoding.DecodeString(keyB64)
	require.NoError(t, err)
	require.Len(t, key, 32)
	require.GreaterOrEqual(t, len(blob), 28)

	block, err := aes.NewCipher(key)
	require.NoError(t, err)
	gcm, err := cipher.NewGCM(block)
	require.NoError(t, err)

	plaintext, err := gcm.Open(nil, blob[:12], blob[12:], nil)
	require.NoError(t, err)

	var parsed partitionedBundle
	require.NoError(t, json.Unmarshal(plaintext, &parsed))
	return parsed
}

func TestBuildBundle_DefaultClassifyAllPublic(t *testing.T) {
	srv := mockBuildServer(t, "test-key", map[string]any{
		"apiUrl":       "https://api.example.com",
		"tavilyApiKey": "tvly-abc",
	})
	defer srv.Close()

	result, err := BuildBundle(context.Background(), BuildBundleOptions{
		BaseURL:     srv.URL,
		AuthURL:     srv.URL,
		APIKey:      "test-key",
		OrgID:       "org-1",
		Environment: "production",
	})
	require.NoError(t, err)
	require.NotNil(t, result)

	// 32-byte key → 44 chars base64.
	require.Len(t, result.KeyB64, 44)
	// Round-trip decrypt → both values land in "public" with the default classifier.
	parsed := decryptBundleForTest(t, result.Blob, result.KeyB64)
	assert.Equal(t, "https://api.example.com", parsed.Public["apiUrl"])
	assert.Equal(t, "tvly-abc", parsed.Public["tavilyApiKey"])
	assert.Empty(t, parsed.Secret)
	assert.Equal(t, 2, result.KeyCount)
	assert.Equal(t, 0, result.SkippedCount)
	assert.Equal(t, int64(len(result.Blob)), result.Size)
}

func TestBuildBundle_Classifier_PartitionsAndSkips(t *testing.T) {
	srv := mockBuildServer(t, "test-key", map[string]any{
		"apiUrl":       "https://api.example.com",
		"tavilyApiKey": "tvly-abc",
		"newFlow":      true, // feature flag — should skip
	})
	defer srv.Close()

	classify := ClassifyFromSchema(
		map[string]bool{"apiUrl": true},
		map[string]bool{"tavilyApiKey": true},
		map[string]bool{"newFlow": true},
	)

	result, err := BuildBundle(context.Background(), BuildBundleOptions{
		BaseURL:  srv.URL,
		AuthURL:  srv.URL,
		APIKey:   "test-key",
		OrgID:    "org-1",
		Classify: classify,
	})
	require.NoError(t, err)

	parsed := decryptBundleForTest(t, result.Blob, result.KeyB64)
	assert.Equal(t, "https://api.example.com", parsed.Public["apiUrl"])
	assert.NotContains(t, parsed.Public, "tavilyApiKey")
	assert.Equal(t, "tvly-abc", parsed.Secret["tavilyApiKey"])
	// Flag dropped.
	assert.NotContains(t, parsed.Public, "newFlow")
	assert.NotContains(t, parsed.Secret, "newFlow")
	assert.Equal(t, 2, result.KeyCount)
	assert.Equal(t, 1, result.SkippedCount)
}

func TestBuildBundle_BlobLayoutMatchesTsPython(t *testing.T) {
	// Minimal sanity check on blob layout: nonce(12) || ct || tag(16).
	srv := mockBuildServer(t, "test-key", map[string]any{"k": "v"})
	defer srv.Close()

	result, err := BuildBundle(context.Background(), BuildBundleOptions{
		BaseURL: srv.URL,
		AuthURL: srv.URL,
		APIKey:  "test-key",
		OrgID:   "org-1",
	})
	require.NoError(t, err)

	// Length is nonce(12) + ciphertext(len of plaintext) + tag(16).
	// Plaintext is JSON of {"public":{"k":"v"},"secret":{}} → 30 bytes.
	require.Greater(t, len(result.Blob), 28)
	// The first 12 bytes are the random nonce — just assert they're not
	// the trailing tag region.
	assert.NotEqual(t, result.Blob[:12], result.Blob[len(result.Blob)-16:])
}

func TestBuildBundle_RemoteFetchError(t *testing.T) {
	// Unauthorized — mock server returns 401.
	srv := mockBuildServer(t, "wrong-key", map[string]any{"k": "v"})
	defer srv.Close()

	_, err := BuildBundle(context.Background(), BuildBundleOptions{
		BaseURL: srv.URL,
		AuthURL: srv.URL,
		APIKey:  "test-key",
		OrgID:   "org-1",
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "config build bundle fetch")
}

func TestBuildBundle_CancelledContext(t *testing.T) {
	srv := mockBuildServer(t, "test-key", map[string]any{"k": "v"})
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel before the call

	_, err := BuildBundle(ctx, BuildBundleOptions{
		BaseURL: srv.URL,
		AuthURL: srv.URL,
		APIKey:  "test-key",
		OrgID:   "org-1",
	})
	require.Error(t, err)
	assert.ErrorIs(t, err, context.Canceled)
}

func TestClassifyFromSchema_SecretWinsOverPublic(t *testing.T) {
	// When a key is in both maps, secret takes precedence — matches TS.
	classify := ClassifyFromSchema(
		map[string]bool{"token": true},
		map[string]bool{"token": true},
		nil,
	)
	assert.Equal(t, ClassifySecret, classify("token", nil))
}

func TestClassifyFromSchema_UnknownKeyDefaultsPublic(t *testing.T) {
	classify := ClassifyFromSchema(nil, nil, nil)
	assert.Equal(t, ClassifyPublic, classify("anything", nil))
}
