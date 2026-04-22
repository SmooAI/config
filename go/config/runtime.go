package config

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"time"
)

// Bake-aware runtime hydrator — parity with TS buildConfigRuntime and
// Python build_config_runtime.
//
// Reads a pre-encrypted JSON blob produced by BuildBundle and exposes a
// fully-hydrated *ConfigManager. The same GetPublicConfig / GetSecretConfig
// calls then resolve public + secret keys from the in-memory cache — no
// HTTP round-trip. Feature flags are never baked — the baker skips them,
// so GetFeatureFlag reads whatever value (if any) lands in the merged
// config from the env / file tiers.
//
// Environment variables (set by the deploy pipeline):
//
//	SMOO_CONFIG_KEY_FILE  — absolute path to the encrypted blob on disk
//	SMOO_CONFIG_KEY       — base64-encoded 32-byte AES-256 key
//
//	SMOOAI_CONFIG_API_URL  — for fallback live lookups when no blob is present
//	SMOOAI_CONFIG_API_KEY
//	SMOOAI_CONFIG_ORG_ID
//	SMOOAI_CONFIG_ENV
//
// Blob layout (matches TS + Python): nonce (12 bytes) || ciphertext || authTag (16 bytes)

// RuntimeOptions configures NewRuntimeConfigManager. Any of these may be
// empty — empty strings fall back to SMOOAI_CONFIG_* env vars via the
// normal ConfigManager defaulting path.
type RuntimeOptions struct {
	// KeyFile overrides the SMOO_CONFIG_KEY_FILE env var.
	KeyFile string
	// KeyB64 overrides the SMOO_CONFIG_KEY env var.
	KeyB64 string

	// APIKey, BaseURL, OrgID, Environment configure the fallback live
	// client used when no blob is present.
	APIKey      string
	BaseURL     string
	OrgID       string
	Environment string

	// CacheTTL is the cache TTL for per-key lookups. Zero uses the
	// ConfigManager default (24h).
	CacheTTL time.Duration

	// EnvOverride replaces os.Getenv lookups (primarily for tests).
	EnvOverride map[string]string

	// Extra ConfigManager options to layer on. Applied last, so callers
	// can override any of the defaults derived from RuntimeOptions.
	Extra []ConfigManagerOption
}

type decryptedBundle struct {
	public map[string]any
	secret map[string]any
}

// decryptBlobFromEnv reads SMOO_CONFIG_KEY_FILE + SMOO_CONFIG_KEY (or their
// explicit overrides) and returns the decrypted {public, secret} map.
// Returns (nil, nil) when either env var is missing — callers fall back to
// a plain live-fetching ConfigManager.
func decryptBlobFromEnv(keyFile, keyB64 string, envOverride map[string]string) (*decryptedBundle, error) {
	getEnv := func(key string) string {
		if envOverride != nil {
			return envOverride[key]
		}
		return os.Getenv(key)
	}

	if keyFile == "" {
		keyFile = getEnv("SMOO_CONFIG_KEY_FILE")
	}
	if keyB64 == "" {
		keyB64 = getEnv("SMOO_CONFIG_KEY")
	}
	if keyFile == "" || keyB64 == "" {
		return nil, nil
	}

	key, err := base64.StdEncoding.DecodeString(keyB64)
	if err != nil {
		return nil, fmt.Errorf("smoo-config decode key: %w", err)
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("SMOO_CONFIG_KEY must decode to 32 bytes (got %d)", len(key))
	}

	blob, err := os.ReadFile(keyFile)
	if err != nil {
		return nil, fmt.Errorf("smoo-config read blob: %w", err)
	}
	// nonce(12) + minimum ciphertext(0) + tag(16) = 28.
	if len(blob) < 28 {
		return nil, fmt.Errorf("smoo-config blob too short (%d bytes)", len(blob))
	}

	nonce := blob[:12]
	ciphertextAndTag := blob[12:]

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("smoo-config aes: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("smoo-config gcm: %w", err)
	}
	plaintext, err := gcm.Open(nil, nonce, ciphertextAndTag, nil)
	if err != nil {
		return nil, fmt.Errorf("smoo-config decrypt: %w", err)
	}

	var parsed partitionedBundle
	if err := json.Unmarshal(plaintext, &parsed); err != nil {
		return nil, fmt.Errorf("smoo-config unmarshal: %w", err)
	}
	pub := parsed.Public
	if pub == nil {
		pub = map[string]any{}
	}
	sec := parsed.Secret
	if sec == nil {
		sec = map[string]any{}
	}
	return &decryptedBundle{public: pub, secret: sec}, nil
}

// NewRuntimeConfigManager constructs a ConfigManager seeded from a
// pre-decrypted baked blob — the bake-aware analogue of NewConfigManager.
//
// Behaviour:
//   - When SMOO_CONFIG_KEY_FILE + SMOO_CONFIG_KEY (or explicit overrides)
//     resolve to a valid blob, the decrypted {public, secret} map is
//     installed as the manager's "remote" tier. GetPublicConfig /
//     GetSecretConfig then resolve from in-memory state with no HTTP
//     round-trip. Env-var overrides still win, file config still layers
//     underneath, deferred values still resolve.
//   - Feature flags are never baked — GetFeatureFlag reads whatever lands
//     in the merged config from env / file tiers (or undefined).
//   - When the blob env vars are absent, returns a regular ConfigManager
//     configured from RuntimeOptions so callers get uniform API semantics
//     even on dev machines without a baked blob.
//   - A decryption failure (bad key, truncated blob, tampered bytes) is
//     returned as an error — the caller chooses whether to fall back or
//     fail loud. There's no silent-fallback path for tampering.
func NewRuntimeConfigManager(opts RuntimeOptions) (*ConfigManager, error) {
	bundle, err := decryptBlobFromEnv(opts.KeyFile, opts.KeyB64, opts.EnvOverride)
	if err != nil {
		return nil, err
	}

	base := []ConfigManagerOption{}
	if opts.APIKey != "" {
		base = append(base, WithAPIKey(opts.APIKey))
	}
	if opts.BaseURL != "" {
		base = append(base, WithBaseURL(opts.BaseURL))
	}
	if opts.OrgID != "" {
		base = append(base, WithOrgID(opts.OrgID))
	}
	if opts.Environment != "" {
		base = append(base, WithConfigEnvironment(opts.Environment))
	}
	if opts.CacheTTL > 0 {
		base = append(base, WithCMCacheTTL(opts.CacheTTL))
	}
	if opts.EnvOverride != nil {
		base = append(base, WithCMEnvOverride(opts.EnvOverride))
	}
	if bundle != nil {
		base = append(base, withBakedConfig(bundle))
	}
	base = append(base, opts.Extra...)

	return NewConfigManager(base...), nil
}

// withBakedConfig installs a pre-decrypted public+secret map as the
// manager's "remote" tier. Package-private: only NewRuntimeConfigManager
// should call it — the BuildBundle → NewRuntimeConfigManager flow is the
// only sanctioned path for pre-seeding.
func withBakedConfig(bundle *decryptedBundle) ConfigManagerOption {
	merged := make(map[string]any, len(bundle.public)+len(bundle.secret))
	for k, v := range bundle.public {
		merged[k] = v
	}
	for k, v := range bundle.secret {
		merged[k] = v
	}
	return func(m *ConfigManager) {
		m.bakedConfig = merged
	}
}
