//! Deploy-time baker for `smooai-config` (Rust parity with TypeScript/Python).
//!
//! Fetches every config value for an environment via [`ConfigClient`], partitions
//! them into `public` and `secret` sections (feature flags are skipped),
//! JSON-encodes the partition, and encrypts with AES-256-GCM. The caller writes
//! the resulting blob to disk, ships it with the function bundle, and sets two
//! environment variables on the runtime:
//!
//! ```text
//! SMOO_CONFIG_KEY_FILE = <absolute path to the blob at runtime>
//! SMOO_CONFIG_KEY      = <returned key_b64>
//! ```
//!
//! At cold start, [`crate::runtime::build_config_runtime`] reads both and
//! decrypts once into an in-memory cache.
//!
//! Blob layout (wire-compatible with the TypeScript + Python bakers):
//! `nonce (12 random bytes) || ciphertext || authTag (16 bytes)`.

use std::collections::HashMap;

use aes_gcm::aead::{Aead, KeyInit, OsRng, Payload};
use aes_gcm::{AeadCore, Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde_json::Value;
use thiserror::Error;

use crate::client::ConfigClient;

/// Classification returned by a [`Classifier`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Classification {
    /// Bake into the `public` partition of the blob.
    Public,
    /// Bake into the `secret` partition of the blob.
    Secret,
    /// Drop — not included in the blob (typically feature flags).
    Skip,
}

/// Classifier type: given a key + value, decides which partition the key lands in.
pub type Classifier = Box<dyn Fn(&str, &Value) -> Classification + Send + Sync>;

/// Inputs for [`build_bundle`]. Mirrors the TypeScript `BuildBundleOptions` shape —
/// bundles the [`ConfigClient`] connection params plus an optional classifier.
pub struct BuildBundleOptions {
    /// Base URL of the config API, e.g. `https://config.smoo.ai`.
    pub base_url: String,
    /// Bearer token used to authenticate with the config API.
    pub api_key: String,
    /// Organization ID that owns the config values.
    pub org_id: String,
    /// Environment to fetch (e.g. `production`, `staging`). Defaults to the
    /// client's own default environment when `None`.
    pub environment: Option<String>,
    /// Per-key classifier. If `None`, every key lands in `public`. Use a
    /// schema-driven classifier for the typical case — the default is rarely
    /// what production code wants.
    pub classify: Option<Classifier>,
}

/// Output of [`build_bundle`].
#[derive(Debug)]
pub struct BuildBundleResult {
    /// Base64-encoded 32-byte AES-256 key. Set as `SMOO_CONFIG_KEY`.
    pub key_b64: String,
    /// Encrypted blob: `nonce || ciphertext || authTag`. Write to disk and
    /// bundle with the function. Point `SMOO_CONFIG_KEY_FILE` at the path.
    pub blob: Vec<u8>,
    /// Size of the blob in bytes.
    pub size: u64,
    /// Number of keys baked into the blob (public + secret).
    pub key_count: usize,
    /// Number of keys skipped (e.g. feature flags).
    pub skipped_count: usize,
}

/// Errors produced by [`build_bundle`].
#[derive(Debug, Error)]
pub enum BuildError {
    /// The live config fetch via [`ConfigClient`] failed.
    #[error("failed to fetch config values: {0}")]
    Fetch(#[from] reqwest::Error),
    /// Serializing the partitioned config to JSON failed.
    #[error("failed to serialize config values to JSON: {0}")]
    Serialize(#[from] serde_json::Error),
    /// AES-GCM encryption failed. In practice this only happens if the AEAD
    /// implementation itself rejects the inputs — effectively unreachable.
    #[error("aes-gcm encryption failed: {0}")]
    Encrypt(String),
}

/// Fetch + encrypt config values for an environment.
///
/// Pulls all values via [`ConfigClient::get_all_values`], runs each through
/// `options.classify` (default: everything goes into `public`), JSON-encodes
/// the `{public, secret}` partition, and encrypts with a fresh random 32-byte
/// AES-256 key + 12-byte nonce. Returns the ciphertext blob and the base64
/// key so the caller can ship both.
pub async fn build_bundle(options: BuildBundleOptions) -> Result<BuildBundleResult, BuildError> {
    let BuildBundleOptions {
        base_url,
        api_key,
        org_id,
        environment,
        classify,
    } = options;

    let mut client = match &environment {
        Some(env) => ConfigClient::with_environment(&base_url, &api_key, &org_id, env),
        None => ConfigClient::new(&base_url, &api_key, &org_id),
    };

    let all = client.get_all_values(environment.as_deref()).await?;

    let mut public_map: HashMap<String, Value> = HashMap::new();
    let mut secret_map: HashMap<String, Value> = HashMap::new();
    let mut skipped_count: usize = 0;

    for (key, value) in all {
        let section = match classify {
            Some(ref f) => f(&key, &value),
            None => Classification::Public,
        };
        match section {
            Classification::Public => {
                public_map.insert(key, value);
            }
            Classification::Secret => {
                secret_map.insert(key, value);
            }
            Classification::Skip => {
                skipped_count += 1;
            }
        }
    }

    let key_count = public_map.len() + secret_map.len();

    // Serialize the partition with a stable shape that the hydrator can parse.
    let partitioned = serde_json::json!({
        "public": public_map,
        "secret": secret_map,
    });
    let plaintext = serde_json::to_vec(&partitioned)?;

    // Generate key and nonce.
    let key_bytes: [u8; 32] = {
        let k = Aes256Gcm::generate_key(&mut OsRng);
        k.into()
    };
    let nonce_bytes: [u8; 12] = {
        let n = Aes256Gcm::generate_nonce(&mut OsRng);
        n.into()
    };

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext_and_tag = cipher
        .encrypt(
            nonce,
            Payload {
                msg: &plaintext,
                aad: &[],
            },
        )
        .map_err(|e| BuildError::Encrypt(e.to_string()))?;

    // Blob layout: nonce || ciphertext || authTag. aes-gcm returns ciphertext
    // with the 16-byte tag already appended, matching the TS and Python wire
    // format.
    let mut blob = Vec::with_capacity(nonce_bytes.len() + ciphertext_and_tag.len());
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ciphertext_and_tag);

    let size = blob.len() as u64;
    let key_b64 = B64.encode(key_bytes);

    Ok(BuildBundleResult {
        key_b64,
        blob,
        size,
        key_count,
        skipped_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path_regex, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn build_bundle_encrypts_and_reports_counts() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path_regex(r"/organizations/.+/config/values"))
            .and(query_param("environment", "production"))
            .and(header("Authorization", "Bearer test-api-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "values": {
                    "apiUrl": "https://api.example.com",
                    "tavilyApiKey": "tvly-abc",
                    "newFlow": true,
                }
            })))
            .mount(&mock_server)
            .await;

        let classify: Classifier = Box::new(|key, _v| match key {
            "tavilyApiKey" => Classification::Secret,
            "newFlow" => Classification::Skip,
            _ => Classification::Public,
        });

        let result = build_bundle(BuildBundleOptions {
            base_url: mock_server.uri(),
            api_key: "test-api-key".to_string(),
            org_id: "test-org".to_string(),
            environment: Some("production".to_string()),
            classify: Some(classify),
        })
        .await
        .unwrap();

        assert_eq!(result.key_count, 2); // apiUrl + tavilyApiKey
        assert_eq!(result.skipped_count, 1); // newFlow
        assert!(result.blob.len() > 12 + 16); // nonce + tag at minimum
        assert_eq!(result.size, result.blob.len() as u64);
        // key_b64 decodes to exactly 32 bytes
        let key = B64.decode(&result.key_b64).unwrap();
        assert_eq!(key.len(), 32);
    }

    #[tokio::test]
    async fn build_bundle_default_classifier_makes_everything_public() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path_regex(r"/organizations/.+/config/values"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "values": {"FOO": "bar", "BAZ": 42}
            })))
            .mount(&mock_server)
            .await;

        let result = build_bundle(BuildBundleOptions {
            base_url: mock_server.uri(),
            api_key: "k".to_string(),
            org_id: "o".to_string(),
            environment: Some("test".to_string()),
            classify: None,
        })
        .await
        .unwrap();

        assert_eq!(result.key_count, 2);
        assert_eq!(result.skipped_count, 0);
    }
}
