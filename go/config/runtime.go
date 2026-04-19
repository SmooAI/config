// Bake-aware runtime hydrator for smooai-config (Go parity with TS/Python/Rust).
//
// Reads a pre-encrypted JSON blob produced by BuildBundle and exposes typed
// sync accessors by seeding a ConfigClient cache. The library API stays
// uniform — consumers always call client.GetValue(key) regardless of whether
// the data came from the baked blob or a live fetch.
//
//   - Public + secret values hydrate from the blob (sync, no network)
//   - Feature flags are never baked — the baker drops them so they stay
//     live-fetched through ConfigClient
//
// Environment variables (set by the deploy pipeline):
//
//	SMOO_CONFIG_KEY_FILE — absolute path to the encrypted blob on disk
//	SMOO_CONFIG_KEY      — base64-encoded 32-byte AES-256 key
//
// Blob layout (matches TS/Python/Rust):
//
//	nonce (12 bytes) || ciphertext || authTag (16 bytes)

package config

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"
)

// BakedBlob is the decrypted `{public, secret}` partition shipped by the
// baker. Feature flags are intentionally absent — they stay live-fetched.
type BakedBlob struct {
	Public map[string]any `json:"public"`
	Secret map[string]any `json:"secret"`
}

var (
	blobCacheOnce sync.Once
	blobCache     *BakedBlob
	blobCacheErr  error
)

func decryptBlob() (*BakedBlob, error) {
	keyFile := os.Getenv("SMOO_CONFIG_KEY_FILE")
	keyB64 := os.Getenv("SMOO_CONFIG_KEY")
	if keyFile == "" || keyB64 == "" {
		return nil, nil
	}

	keyBytes, err := base64.StdEncoding.DecodeString(keyB64)
	if err != nil {
		return nil, fmt.Errorf("config runtime: base64 decode key: %w", err)
	}
	if len(keyBytes) != 32 {
		return nil, fmt.Errorf("config runtime: SMOO_CONFIG_KEY must decode to 32 bytes (got %d)", len(keyBytes))
	}

	blob, err := os.ReadFile(keyFile)
	if err != nil {
		return nil, fmt.Errorf("config runtime: read blob: %w", err)
	}
	if len(blob) < 28 {
		return nil, fmt.Errorf("config runtime: blob too short (%d bytes)", len(blob))
	}

	block, err := aes.NewCipher(keyBytes)
	if err != nil {
		return nil, fmt.Errorf("config runtime: aes.NewCipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("config runtime: cipher.NewGCM: %w", err)
	}

	nonce := blob[:12]
	ciphertext := blob[12:]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, fmt.Errorf("config runtime: AES-GCM decrypt failed: %w", err)
	}

	var parsed BakedBlob
	if err := json.Unmarshal(plaintext, &parsed); err != nil {
		return nil, fmt.Errorf("config runtime: parse decrypted blob: %w", err)
	}
	return &parsed, nil
}

// ReadBakedConfig decrypts the baked blob once and caches the result for the
// process lifetime. Returns nil (with no error) when no blob is present (env
// vars unset) — callers should treat that as "no hydration data available"
// and fall back to live HTTP fetches.
func ReadBakedConfig() (*BakedBlob, error) {
	blobCacheOnce.Do(func() {
		blobCache, blobCacheErr = decryptBlob()
	})
	return blobCache, blobCacheErr
}

// HydrateConfigClient seeds a ConfigClient's cache from the baked blob.
//
// After this call, client.GetValue(key) resolves public + secret keys from
// the in-memory cache (no HTTP). Feature flags keep live-fetch semantics
// because the baker omits them from the blob.
//
// Returns the number of keys seeded (0 when no blob is present). Pass empty
// string for environment to use the client's default.
func HydrateConfigClient(client *ConfigClient, environment string) (int, error) {
	if client == nil {
		return 0, errors.New("config runtime: nil ConfigClient")
	}
	blob, err := ReadBakedConfig()
	if err != nil {
		return 0, err
	}
	if blob == nil {
		return 0, nil
	}
	merged := make(map[string]any, len(blob.Public)+len(blob.Secret))
	for k, v := range blob.Public {
		merged[k] = v
	}
	for k, v := range blob.Secret {
		merged[k] = v
	}
	client.SeedCacheFromMap(merged, environment)
	return len(merged), nil
}

// BuildConfigRuntime constructs a ConfigClient from env vars and hydrates it
// with the baked blob. Public + secret values resolve sync-fast (no HTTP)
// via GetValue. Feature flags hit the live API with the client's cache TTL.
//
// Pass zero duration to use the default cache behavior.
func BuildConfigRuntime(flagCacheTTL time.Duration) (*ConfigClient, error) {
	opts := []ConfigClientOption{}
	if flagCacheTTL > 0 {
		opts = append(opts, WithCacheTTL(flagCacheTTL))
	}
	client := NewConfigClient("", "", "", opts...)
	if _, err := HydrateConfigClient(client, ""); err != nil {
		client.Close()
		return nil, err
	}
	return client, nil
}

// resetRuntimeBlobCacheForTest clears the process-lifetime cache for tests.
// Do not call outside of tests — this function is not part of the public API.
func resetRuntimeBlobCacheForTest() {
	blobCacheOnce = sync.Once{}
	blobCache = nil
	blobCacheErr = nil
}
