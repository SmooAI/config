package config

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
)

// Deploy-time baker — framework-agnostic.
//
// Fetches `public` + `secret` config values for an environment, encrypts the
// JSON with AES-256-GCM, and returns the ciphertext blob + base64-encoded
// key. Deploy glue (SST/Vercel/Cloudflare/anything) writes the blob to disk,
// ships it in the function bundle, and sets two env vars on the function:
//
//	SMOO_CONFIG_KEY_FILE = <absolute path to the blob on disk at runtime>
//	SMOO_CONFIG_KEY      = <returned KeyB64>
//
// At cold start, NewRuntimeConfigManager reads both and decrypts once into
// an in-memory cache. No runtime fetch for public + secret values.
//
// Feature flags are intentionally NOT baked — they're designed to flip
// without a redeploy, so they stay live-fetched via ConfigClient. Pass a
// Classify function (or use ClassifyFromSchema) so the baker knows which
// keys to drop.
//
// Blob layout (wire-compatible with the TS + Python bakers):
//
//	nonce (12 random bytes) || ciphertext || authTag (16 bytes)

// ClassifyResult is the output of a Classifier. One of "public", "secret",
// or "skip" — "skip" omits the key from the blob (e.g., for feature flags).
type ClassifyResult string

const (
	ClassifyPublic ClassifyResult = "public"
	ClassifySecret ClassifyResult = "secret"
	ClassifySkip   ClassifyResult = "skip"
)

// Classifier assigns each key to "public", "secret", or "skip".
type Classifier func(key string, value any) ClassifyResult

func defaultClassify(_ string, _ any) ClassifyResult {
	return ClassifyPublic
}

// BuildBundleOptions configures BuildBundle.
//
// The ConfigClient fields (BaseURL, APIKey, OrgID) are required for the
// remote fetch. Environment picks which slice of config to bake. If no
// Classify is provided, every key is bucketed into "public" — almost never
// what you want; use ClassifyFromSchema instead.
type BuildBundleOptions struct {
	// BaseURL is the config API base URL (e.g. https://api.smoo.ai).
	BaseURL string
	// AuthURL is the OAuth issuer URL (e.g. https://auth.smoo.ai). When
	// empty, the runtime ConfigClient falls back to its own defaults
	// (env var or https://auth.smoo.ai). SMOODEV-975.
	AuthURL string
	// ClientID is the OAuth2 client_credentials client ID. Required for
	// the runtime OAuth handshake (SMOODEV-975). When empty, falls back
	// to APIKey so legacy deploy scripts still work.
	ClientID string
	// APIKey is the OAuth client secret used to mint a JWT. (Field name
	// retained for backwards-compat with existing deploy glue; treat it
	// as the client secret.)
	APIKey string
	// OrgID identifies the organization whose values will be fetched.
	OrgID string
	// Environment selects which environment's values to bake
	// (e.g. "production"). Empty uses the client default.
	Environment string
	// Classify decides which section each key lands in. Return
	// ClassifySkip to drop a key (feature flags).
	Classify Classifier
}

// BuildBundleResult is the output of BuildBundle.
type BuildBundleResult struct {
	// KeyB64 is the base64-encoded 32-byte AES-256 key. Set as SMOO_CONFIG_KEY.
	KeyB64 string
	// Blob is the encrypted blob: nonce || ciphertext || authTag.
	// Write this to disk and bundle with the function artifact.
	Blob []byte
	// Size is the length of Blob in bytes.
	Size int64
	// KeyCount is the number of keys baked (public + secret).
	KeyCount int
	// SkippedCount is the number of keys skipped (e.g., feature flags).
	SkippedCount int
}

// ClassifyFromSchema builds a Classifier driven by explicit key sets.
//
// Feature-flag keys return ClassifySkip — they stay live-fetched at runtime.
// Unknown keys default to ClassifyPublic to match the TS/Python behaviour.
func ClassifyFromSchema(publicKeys, secretKeys, featureFlagKeys map[string]bool) Classifier {
	return func(key string, _ any) ClassifyResult {
		if secretKeys[key] {
			return ClassifySecret
		}
		if publicKeys[key] {
			return ClassifyPublic
		}
		if featureFlagKeys[key] {
			return ClassifySkip
		}
		return ClassifyPublic
	}
}

// partitionedBundle is the JSON shape baked into the blob. Matches the
// TS/Python layout exactly so blobs are cross-language compatible.
type partitionedBundle struct {
	Public map[string]any `json:"public"`
	Secret map[string]any `json:"secret"`
}

// BuildBundle fetches every config value for an environment, partitions
// them via the classifier, encrypts the JSON with AES-256-GCM, and returns
// the ciphertext blob + base64-encoded key.
//
// The caller is responsible for persisting the result: write Blob to disk
// alongside the function bundle, and surface KeyB64 via the deploy pipeline
// (typically as a secret env var).
//
// Returns an error if the remote fetch, JSON encoding, or AES-GCM sealing
// fails. ctx is threaded through the underlying fetch where available.
func BuildBundle(ctx context.Context, opts BuildBundleOptions) (*BuildBundleResult, error) {
	classify := opts.Classify
	if classify == nil {
		classify = defaultClassify
	}

	clientID := opts.ClientID
	if clientID == "" {
		clientID = opts.APIKey
	}
	clientOpts := []ConfigClientOption{}
	if opts.AuthURL != "" {
		clientOpts = append(clientOpts, WithAuthURL(opts.AuthURL))
	}
	client := NewConfigClient(opts.BaseURL, clientID, opts.APIKey, opts.OrgID, clientOpts...)
	defer client.Close()

	// Respect ctx cancellation before network work starts. The existing
	// ConfigClient predates context.Context; cancelling before the fetch
	// is the cleanest win we can offer without reshaping the client.
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("config build bundle: %w", err)
	}

	values, err := client.GetAllValues(opts.Environment)
	if err != nil {
		return nil, fmt.Errorf("config build bundle fetch: %w", err)
	}

	partitioned := partitionedBundle{
		Public: make(map[string]any),
		Secret: make(map[string]any),
	}
	skipped := 0
	for k, v := range values {
		switch classify(k, v) {
		case ClassifySkip:
			skipped++
		case ClassifySecret:
			partitioned.Secret[k] = v
		case ClassifyPublic:
			partitioned.Public[k] = v
		default:
			// Unknown classifier output — treat as public to stay
			// consistent with TS/Python defaults.
			partitioned.Public[k] = v
		}
	}

	plaintext, err := json.Marshal(partitioned)
	if err != nil {
		return nil, fmt.Errorf("config build bundle marshal: %w", err)
	}

	key := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return nil, fmt.Errorf("config build bundle rand key: %w", err)
	}
	nonce := make([]byte, 12)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("config build bundle rand nonce: %w", err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("config build bundle aes: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("config build bundle gcm: %w", err)
	}

	// gcm.Seal returns ciphertext||authTag appended to the prefix arg —
	// reuse that allocation by seeding it with the nonce so the final
	// slice is nonce || ciphertext || authTag in one go.
	blob := gcm.Seal(append([]byte(nil), nonce...), nonce, plaintext, nil)

	return &BuildBundleResult{
		KeyB64:       base64.StdEncoding.EncodeToString(key),
		Blob:         blob,
		Size:         int64(len(blob)),
		KeyCount:     len(partitioned.Public) + len(partitioned.Secret),
		SkippedCount: skipped,
	}, nil
}
