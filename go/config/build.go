// Deploy-time baker for smooai-config (Go parity with TS/Python/Rust).
//
// Fetches every config value for an environment via ConfigClient, partitions
// into public/secret sections (feature flags skipped), encrypts the JSON with
// AES-256-GCM, and returns the ciphertext blob + base64-encoded key. Deploy
// glue writes the blob to disk, ships it in the function bundle, and sets two
// environment variables on the function:
//
//	SMOO_CONFIG_KEY_FILE — absolute path to the blob at runtime
//	SMOO_CONFIG_KEY      — the returned KeyB64
//
// At cold start, BuildConfigRuntime reads both and decrypts once into an
// in-memory cache.
//
// Blob layout (wire-compatible with TS/Python/Rust):
//
//	nonce (12 random bytes) || ciphertext || authTag (16 bytes)

package config

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
)

// ClassifyResult is the bake-time section assignment for a config key.
type ClassifyResult int

const (
	// ClassifyPublic → bake into the blob's public section.
	ClassifyPublic ClassifyResult = iota
	// ClassifySecret → bake into the blob's secret section.
	ClassifySecret
	// ClassifySkip → omit from the blob (feature flags stay live-fetched).
	ClassifySkip
)

// Classifier is invoked once per key returned by GetAllValues.
type Classifier func(key string, value any) ClassifyResult

// DefaultClassify treats every key as public. Almost never what you want;
// use ClassifyFromSchema in production.
func DefaultClassify(_ string, _ any) ClassifyResult {
	return ClassifyPublic
}

// ClassifyFromSchema returns a Classifier driven by pre-extracted key sets.
// Feature-flag keys resolve to ClassifySkip so the baker omits them.
func ClassifyFromSchema(publicKeys, secretKeys, featureFlagKeys map[string]struct{}) Classifier {
	return func(key string, _ any) ClassifyResult {
		if _, ok := secretKeys[key]; ok {
			return ClassifySecret
		}
		if _, ok := publicKeys[key]; ok {
			return ClassifyPublic
		}
		if _, ok := featureFlagKeys[key]; ok {
			return ClassifySkip
		}
		return ClassifyPublic
	}
}

// BuildBundleResult is the output of BuildBundle.
type BuildBundleResult struct {
	// KeyB64 is the base64-encoded 32-byte AES-256 key. Set as SMOO_CONFIG_KEY.
	KeyB64 string
	// Bundle is the encrypted blob (nonce || ciphertext || authTag).
	Bundle []byte
	// KeyCount is the number of keys baked (public + secret).
	KeyCount int
	// SkippedCount is the number of keys skipped (feature flags).
	SkippedCount int
}

// BuildBundleArgs is the argument struct for BuildBundle.
type BuildBundleArgs struct {
	BaseURL     string
	APIKey      string
	OrgID       string
	Environment string
	// Classify is optional — when nil, defaults to DefaultClassify.
	Classify Classifier
}

// BuildBundle fetches + encrypts config values for an environment.
//
// Uses ConfigClient to pull every value via GetAllValues, runs each through
// Classify, JSON-encodes the {public, secret} partition, and encrypts with a
// fresh AES-256-GCM key and random 12-byte nonce.
func BuildBundle(args BuildBundleArgs) (*BuildBundleResult, error) {
	classify := args.Classify
	if classify == nil {
		classify = DefaultClassify
	}

	client := NewConfigClient(args.BaseURL, args.APIKey, args.OrgID)
	defer client.Close()

	allValues, err := client.GetAllValues(args.Environment)
	if err != nil {
		return nil, fmt.Errorf("build bundle: fetch values: %w", err)
	}

	publicMap := map[string]any{}
	secretMap := map[string]any{}
	skipped := 0

	for key, value := range allValues {
		switch classify(key, value) {
		case ClassifyPublic:
			publicMap[key] = value
		case ClassifySecret:
			secretMap[key] = value
		case ClassifySkip:
			skipped++
		}
	}

	plaintext, err := json.Marshal(map[string]any{
		"public": publicMap,
		"secret": secretMap,
	})
	if err != nil {
		return nil, fmt.Errorf("build bundle: marshal partition: %w", err)
	}

	keyBytes := make([]byte, 32)
	if _, err := rand.Read(keyBytes); err != nil {
		return nil, fmt.Errorf("build bundle: generate AES key: %w", err)
	}
	nonce := make([]byte, 12)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("build bundle: generate nonce: %w", err)
	}

	block, err := aes.NewCipher(keyBytes)
	if err != nil {
		return nil, fmt.Errorf("build bundle: aes.NewCipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("build bundle: cipher.NewGCM: %w", err)
	}
	ciphertextAndTag := gcm.Seal(nil, nonce, plaintext, nil)

	bundle := make([]byte, 0, len(nonce)+len(ciphertextAndTag))
	bundle = append(bundle, nonce...)
	bundle = append(bundle, ciphertextAndTag...)

	return &BuildBundleResult{
		KeyB64:       base64.StdEncoding.EncodeToString(keyBytes),
		Bundle:       bundle,
		KeyCount:     len(publicMap) + len(secretMap),
		SkippedCount: skipped,
	}, nil
}
