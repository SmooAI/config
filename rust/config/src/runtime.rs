//! Bake-aware runtime hydrator for `smooai-config` (Rust parity with TypeScript/Python).
//!
//! Reads a pre-encrypted blob produced by [`crate::build::build_bundle`] and
//! exposes sync accessors by seeding a [`ConfigManager`]'s merged-config map.
//! The library API stays uniform — consumers always call
//! `manager.get_public_config(key)` / `manager.get_secret_config(key)`
//! regardless of whether the data came from the baked blob or a live fetch.
//!
//! - Public + secret values hydrate from the blob (sync, no network)
//! - Feature flags are never baked — they stay live-fetched through the
//!   normal [`ConfigManager`] merge pipeline when env vars are absent.
//!
//! Environment variables (set by the deploy pipeline):
//!
//! ```text
//! SMOO_CONFIG_KEY_FILE  — absolute path to the encrypted blob on disk
//! SMOO_CONFIG_KEY       — base64-encoded 32-byte AES-256 key
//! ```
//!
//! Blob layout (matches TypeScript + Python):
//! `nonce (12 bytes) || ciphertext || authTag (16 bytes)`.

use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde_json::Value;
use thiserror::Error;

use crate::config_manager::ConfigManager;

/// Options for [`build_config_runtime`]. All fields optional — the function
/// falls back to environment variables / defaults for anything left unset.
#[derive(Default)]
pub struct RuntimeOptions {
    /// Override `SMOO_CONFIG_KEY_FILE` (blob path on disk).
    pub key_file: Option<PathBuf>,
    /// Override `SMOO_CONFIG_KEY` (base64 AES-256 key).
    pub key_b64: Option<String>,
    /// Override the `ConfigManager`'s environment name (e.g. `production`).
    pub environment: Option<String>,
}

/// Errors produced by [`build_config_runtime`] and related helpers.
#[derive(Debug, Error)]
pub enum RuntimeError {
    /// The key file pointed to by `SMOO_CONFIG_KEY_FILE` could not be read.
    #[error("failed to read config key file {path}: {source}")]
    KeyFileRead {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    /// `SMOO_CONFIG_KEY` was not valid base64.
    #[error("SMOO_CONFIG_KEY is not valid base64: {0}")]
    InvalidKeyBase64(#[from] base64::DecodeError),
    /// `SMOO_CONFIG_KEY` decoded to something other than 32 bytes.
    #[error("SMOO_CONFIG_KEY must decode to 32 bytes (got {0})")]
    InvalidKeyLength(usize),
    /// The blob is shorter than the minimum possible layout.
    #[error("smoo-config blob too short ({0} bytes)")]
    BlobTooShort(usize),
    /// AES-GCM authentication / decryption failed. Either the key is wrong or
    /// the blob has been tampered with.
    #[error("aes-gcm decryption failed (wrong key or tampered blob)")]
    Decrypt,
    /// The decrypted plaintext was not valid JSON with the expected shape.
    #[error("failed to parse decrypted config JSON: {0}")]
    ParseJson(#[from] serde_json::Error),
    /// Seeding the [`ConfigManager`] failed (lock poisoning).
    #[error("failed to seed ConfigManager: {0}")]
    Seed(String),
}

/// Decrypt a baked blob if the required env vars / overrides are present.
///
/// Returns `Ok(None)` when no blob is configured — the caller should fall back
/// to a live-fetch [`ConfigManager`]. Returns `Ok(Some({public, secret}))` on
/// success, where each inner map is the decrypted JSON section.
pub fn read_baked_config(opts: &RuntimeOptions) -> Result<Option<BakedConfig>, RuntimeError> {
    let key_file = opts
        .key_file
        .clone()
        .or_else(|| env::var_os("SMOO_CONFIG_KEY_FILE").map(PathBuf::from));
    let key_b64 = opts.key_b64.clone().or_else(|| env::var("SMOO_CONFIG_KEY").ok());

    let (Some(key_file), Some(key_b64)) = (key_file, key_b64) else {
        return Ok(None);
    };

    let key = B64.decode(key_b64.as_bytes())?;
    if key.len() != 32 {
        return Err(RuntimeError::InvalidKeyLength(key.len()));
    }

    let blob = fs::read(&key_file).map_err(|source| RuntimeError::KeyFileRead {
        path: key_file.clone(),
        source,
    })?;

    decrypt_blob(&key, &blob).map(Some)
}

/// Decrypted `{public, secret}` partition from a baked blob.
#[derive(Debug, Default, Clone)]
pub struct BakedConfig {
    pub public: HashMap<String, Value>,
    pub secret: HashMap<String, Value>,
}

impl BakedConfig {
    /// Total number of baked entries (public + secret).
    pub fn len(&self) -> usize {
        self.public.len() + self.secret.len()
    }

    /// Whether the baked config contains zero entries.
    pub fn is_empty(&self) -> bool {
        self.public.is_empty() && self.secret.is_empty()
    }

    /// Merge public + secret into a single flat map. Secret keys win on
    /// collisions, matching the TS/Python hydrator semantics.
    pub fn into_merged(self) -> HashMap<String, Value> {
        let mut merged = self.public;
        for (k, v) in self.secret {
            merged.insert(k, v);
        }
        merged
    }
}

fn decrypt_blob(key: &[u8], blob: &[u8]) -> Result<BakedConfig, RuntimeError> {
    // Minimum layout: 12-byte nonce + 16-byte tag = 28 bytes before any ciphertext.
    if blob.len() < 12 + 16 {
        return Err(RuntimeError::BlobTooShort(blob.len()));
    }
    let (nonce_bytes, ciphertext_and_tag) = blob.split_at(12);

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher
        .decrypt(
            nonce,
            Payload {
                msg: ciphertext_and_tag,
                aad: &[],
            },
        )
        .map_err(|_| RuntimeError::Decrypt)?;

    #[derive(serde::Deserialize, Default)]
    struct Partitioned {
        #[serde(default)]
        public: HashMap<String, Value>,
        #[serde(default)]
        secret: HashMap<String, Value>,
    }
    let parsed: Partitioned = serde_json::from_slice(&plaintext)?;
    Ok(BakedConfig {
        public: parsed.public,
        secret: parsed.secret,
    })
}

/// Build a bake-aware [`ConfigManager`].
///
/// Reads `SMOO_CONFIG_KEY_FILE` + `SMOO_CONFIG_KEY` at cold start and seeds a
/// fresh [`ConfigManager`] with the decrypted public + secret values. If
/// either env var is missing, returns a plain [`ConfigManager`] that lazily
/// loads from file/env/remote on first access — preserving a graceful fallback
/// path for local development.
///
/// Feature flags are never baked; the [`ConfigManager`] falls through to the
/// live-fetch pipeline for `get_feature_flag` calls when no seeded entry
/// exists.
pub async fn build_config_runtime(opts: RuntimeOptions) -> Result<ConfigManager, RuntimeError> {
    let mut manager = ConfigManager::new();
    if let Some(env) = opts.environment.as_deref() {
        manager = manager.with_environment(env);
    }

    match read_baked_config(&opts)? {
        Some(baked) => {
            let merged = baked.into_merged();
            manager
                .seed_from_baked(merged)
                .map_err(|e| RuntimeError::Seed(e.to_string()))?;
        }
        None => {
            // No blob configured — caller gets a live-fetch manager. Nothing
            // else to do here; lazy init will pull from file/env/remote on
            // first access.
        }
    }

    Ok(manager)
}

/// Convenience: decrypt a blob from an explicit path + key, bypassing env vars.
///
/// Mostly useful for tests and one-off scripts. Prefer
/// [`build_config_runtime`] in production code.
pub fn read_baked_config_from(path: &Path, key_b64: &str) -> Result<BakedConfig, RuntimeError> {
    let key = B64.decode(key_b64.as_bytes())?;
    if key.len() != 32 {
        return Err(RuntimeError::InvalidKeyLength(key.len()));
    }
    let blob = fs::read(path).map_err(|source| RuntimeError::KeyFileRead {
        path: path.to_path_buf(),
        source,
    })?;
    decrypt_blob(&key, &blob)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build::{build_bundle, BuildBundleOptions, Classification, Classifier};
    use std::io::Write;
    use wiremock::matchers::{header, method, path_regex};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    // --- Helpers ---

    async fn bake_fixture(values: serde_json::Value, classify: Option<Classifier>) -> (String, Vec<u8>) {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path_regex(r"/organizations/.+/config/values"))
            .and(header("Authorization", "Bearer test-api-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "values": values
            })))
            .mount(&mock_server)
            .await;

        let result = build_bundle(BuildBundleOptions {
            base_url: mock_server.uri(),
            api_key: "test-api-key".to_string(),
            org_id: "test-org".to_string(),
            environment: Some("test".to_string()),
            classify,
        })
        .await
        .unwrap();

        (result.key_b64, result.blob)
    }

    fn write_blob(dir: &tempfile::TempDir, blob: &[u8]) -> PathBuf {
        let path = dir.path().join("smoo-config.enc");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(blob).unwrap();
        path
    }

    // --- Test: round-trip bake → hydrate → retrieve ---
    #[tokio::test]
    async fn round_trip_bake_hydrate() {
        let classify: Classifier = Box::new(|key, _v| match key {
            "tavilyApiKey" => Classification::Secret,
            _ => Classification::Public,
        });

        let (key_b64, blob) = bake_fixture(
            serde_json::json!({
                "apiUrl": "https://api.example.com",
                "tavilyApiKey": "tvly-abc",
            }),
            Some(classify),
        )
        .await;

        let dir = tempfile::tempdir().unwrap();
        let blob_path = write_blob(&dir, &blob);

        let manager = build_config_runtime(RuntimeOptions {
            key_file: Some(blob_path),
            key_b64: Some(key_b64),
            environment: Some("test".to_string()),
        })
        .await
        .unwrap();

        // Public + secret both retrievable via sync accessors (no network).
        assert_eq!(
            manager.get_public_config("apiUrl").unwrap(),
            Some(serde_json::json!("https://api.example.com"))
        );
        assert_eq!(
            manager.get_secret_config("tavilyApiKey").unwrap(),
            Some(serde_json::json!("tvly-abc"))
        );
    }

    // --- Test: wrong key rejects via AES-GCM tag verification ---
    #[tokio::test]
    async fn wrong_key_rejects() {
        let (_key_b64, blob) = bake_fixture(serde_json::json!({"apiUrl": "https://api.example.com"}), None).await;

        let dir = tempfile::tempdir().unwrap();
        let blob_path = write_blob(&dir, &blob);

        // Random wrong key of the correct length (32 bytes).
        let wrong_key = B64.encode([0xFFu8; 32]);

        let result = build_config_runtime(RuntimeOptions {
            key_file: Some(blob_path),
            key_b64: Some(wrong_key),
            environment: None,
        })
        .await;

        match result {
            Err(RuntimeError::Decrypt) => {}
            other => panic!("expected Decrypt error, got: {:?}", other.err()),
        }
    }

    // --- Test: tampered blob rejects ---
    #[tokio::test]
    async fn tampered_blob_rejects() {
        let (key_b64, mut blob) = bake_fixture(serde_json::json!({"apiUrl": "https://api.example.com"}), None).await;

        // Flip a byte in the ciphertext region (past the 12-byte nonce).
        blob[20] ^= 0x01;

        let dir = tempfile::tempdir().unwrap();
        let blob_path = write_blob(&dir, &blob);

        let result = build_config_runtime(RuntimeOptions {
            key_file: Some(blob_path),
            key_b64: Some(key_b64),
            environment: None,
        })
        .await;

        match result {
            Err(RuntimeError::Decrypt) => {}
            other => panic!("expected Decrypt error, got: {:?}", other.err()),
        }
    }

    // --- Test: missing key file falls back gracefully (no blob loaded) ---
    #[tokio::test]
    async fn missing_env_falls_back_gracefully() {
        // Both env vars unset — no override either — should succeed and
        // return a live-fetch ConfigManager with no seeded state.
        // Guard the real env to avoid interference from the caller's shell.
        let prev_file = env::var_os("SMOO_CONFIG_KEY_FILE");
        let prev_key = env::var_os("SMOO_CONFIG_KEY");
        // SAFETY: tests in this module run single-threaded relative to these
        // env vars. We restore the prior values at the end.
        unsafe {
            env::remove_var("SMOO_CONFIG_KEY_FILE");
            env::remove_var("SMOO_CONFIG_KEY");
        }

        let result = build_config_runtime(RuntimeOptions::default()).await;

        // Restore before asserting to keep failure output clean.
        unsafe {
            if let Some(v) = prev_file {
                env::set_var("SMOO_CONFIG_KEY_FILE", v);
            }
            if let Some(v) = prev_key {
                env::set_var("SMOO_CONFIG_KEY", v);
            }
        }

        let _manager = result.expect("should return a live-fetch manager with no error");
    }

    // --- Test: missing key file (path does not exist) is a hard error ---
    #[tokio::test]
    async fn missing_key_file_path_errors() {
        let dir = tempfile::tempdir().unwrap();
        let nonexistent = dir.path().join("does-not-exist.enc");

        let result = build_config_runtime(RuntimeOptions {
            key_file: Some(nonexistent),
            key_b64: Some(B64.encode([0u8; 32])),
            environment: None,
        })
        .await;

        match result {
            Err(RuntimeError::KeyFileRead { .. }) => {}
            other => panic!("expected KeyFileRead error, got: {:?}", other.err()),
        }
    }

    // --- Test: invalid key length ---
    #[tokio::test]
    async fn invalid_key_length_errors() {
        let dir = tempfile::tempdir().unwrap();
        let blob_path = write_blob(&dir, &[0u8; 64]);

        let result = build_config_runtime(RuntimeOptions {
            key_file: Some(blob_path),
            // 16-byte key, not 32.
            key_b64: Some(B64.encode([0u8; 16])),
            environment: None,
        })
        .await;

        match result {
            Err(RuntimeError::InvalidKeyLength(16)) => {}
            other => panic!("expected InvalidKeyLength(16), got: {:?}", other.err()),
        }
    }

    // --- Test: classifier skip logic — feature flags dropped from blob ---
    #[tokio::test]
    async fn classifier_skip_drops_feature_flags() {
        let classify: Classifier = Box::new(|key, _v| match key {
            "apiUrl" => Classification::Public,
            "dbPassword" => Classification::Secret,
            "newFlow" => Classification::Skip,
            _ => Classification::Public,
        });

        let (key_b64, blob) = bake_fixture(
            serde_json::json!({
                "apiUrl": "https://api.example.com",
                "dbPassword": "super-secret",
                "newFlow": true,
            }),
            Some(classify),
        )
        .await;

        let dir = tempfile::tempdir().unwrap();
        let blob_path = write_blob(&dir, &blob);

        let manager = build_config_runtime(RuntimeOptions {
            key_file: Some(blob_path),
            key_b64: Some(key_b64),
            environment: Some("test".to_string()),
        })
        .await
        .unwrap();

        // Public + secret are in the seeded map.
        assert_eq!(
            manager.get_public_config("apiUrl").unwrap(),
            Some(serde_json::json!("https://api.example.com"))
        );
        assert_eq!(
            manager.get_secret_config("dbPassword").unwrap(),
            Some(serde_json::json!("super-secret"))
        );
        // Feature flag was dropped — not in the seeded config.
        assert_eq!(manager.get_feature_flag("newFlow").unwrap(), None);
    }

    // --- Test: blob too short ---
    #[tokio::test]
    async fn blob_too_short_errors() {
        let dir = tempfile::tempdir().unwrap();
        // Only 10 bytes — below the 28-byte minimum (12 nonce + 16 tag).
        let blob_path = write_blob(&dir, &[0u8; 10]);

        let result = build_config_runtime(RuntimeOptions {
            key_file: Some(blob_path),
            key_b64: Some(B64.encode([0u8; 32])),
            environment: None,
        })
        .await;

        match result {
            Err(RuntimeError::BlobTooShort(10)) => {}
            other => panic!("expected BlobTooShort(10), got: {:?}", other.err()),
        }
    }

    // --- Test: read_baked_config returns None when opts/env both absent ---
    #[tokio::test]
    async fn read_baked_config_returns_none_without_env() {
        // Guard real env to keep the test hermetic.
        let prev_file = env::var_os("SMOO_CONFIG_KEY_FILE");
        let prev_key = env::var_os("SMOO_CONFIG_KEY");
        unsafe {
            env::remove_var("SMOO_CONFIG_KEY_FILE");
            env::remove_var("SMOO_CONFIG_KEY");
        }

        let result = read_baked_config(&RuntimeOptions::default());

        unsafe {
            if let Some(v) = prev_file {
                env::set_var("SMOO_CONFIG_KEY_FILE", v);
            }
            if let Some(v) = prev_key {
                env::set_var("SMOO_CONFIG_KEY", v);
            }
        }

        assert!(result.unwrap().is_none());
    }
}
