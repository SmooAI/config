//! Deploy-time baker for smooai-config (Rust parity with TypeScript/Python).
//!
//! Fetches every config value for an environment via [`ConfigClient`], partitions
//! into public/secret sections (feature flags skipped), encrypts the JSON with
//! AES-256-GCM, and returns the ciphertext blob + base64-encoded key. Deploy
//! glue writes the blob to disk, ships it in the function bundle, and sets two
//! environment variables on the function:
//!
//!   `SMOO_CONFIG_KEY_FILE` — absolute path to the blob at runtime
//!   `SMOO_CONFIG_KEY`      — the returned `key_b64`
//!
//! At cold start, [`crate::runtime::build_config_runtime`] reads both and
//! decrypts once into an in-memory cache.
//!
//! Blob layout (wire-compatible with TypeScript + Python):
//!   `nonce (12 random bytes) || ciphertext || authTag (16 bytes)`

use std::collections::{HashMap, HashSet};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose, Engine as _};
use rand::RngCore;

use crate::client::ConfigClient;

/// Classification for a config key at bake time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClassifyResult {
    /// Bake into the blob's `public` section.
    Public,
    /// Bake into the blob's `secret` section.
    Secret,
    /// Omit from the blob (feature flags stay live-fetched).
    Skip,
}

/// Classifier function invoked once per key returned by `get_all_values`.
pub type Classifier = Box<dyn Fn(&str, &serde_json::Value) -> ClassifyResult + Send + Sync>;

/// Default classifier — treats every key as public. Almost never what you want;
/// pass a real classifier via [`classify_from_schema`] in production.
pub fn default_classify() -> Classifier {
    Box::new(|_key, _value| ClassifyResult::Public)
}

/// Classifier factory driven by pre-extracted key sets.
///
/// Feature flags resolve to `Skip` so the baker omits them from the blob —
/// feature flags keep live-fetch semantics at runtime.
pub fn classify_from_schema(
    public_keys: HashSet<String>,
    secret_keys: HashSet<String>,
    feature_flag_keys: HashSet<String>,
) -> Classifier {
    Box::new(move |key, _value| {
        if secret_keys.contains(key) {
            ClassifyResult::Secret
        } else if public_keys.contains(key) {
            ClassifyResult::Public
        } else if feature_flag_keys.contains(key) {
            ClassifyResult::Skip
        } else {
            ClassifyResult::Public
        }
    })
}

/// Result of [`build_bundle`].
#[derive(Debug)]
pub struct BuildBundleResult {
    /// Base64-encoded 32-byte AES-256 key. Set as `SMOO_CONFIG_KEY`.
    pub key_b64: String,
    /// Encrypted blob (`nonce || ciphertext || authTag`).
    pub bundle: Vec<u8>,
    /// Number of keys baked (public + secret).
    pub key_count: usize,
    /// Number of keys skipped (feature flags).
    pub skipped_count: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum BuildError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("AES-GCM encrypt failed: {0}")]
    Encrypt(String),
}

/// Fetch + encrypt config values for an environment.
///
/// Uses [`ConfigClient`] to pull every value via `get_all_values`, runs each
/// through `classify`, JSON-encodes the `{public, secret}` partition, and
/// encrypts with a fresh AES-256-GCM key and random 12-byte nonce.
pub async fn build_bundle(
    base_url: &str,
    api_key: &str,
    org_id: &str,
    environment: &str,
    classify: Option<Classifier>,
) -> Result<BuildBundleResult, BuildError> {
    let classify_fn = classify.unwrap_or_else(default_classify);

    let mut client = ConfigClient::with_environment(base_url, api_key, org_id, environment);
    let all_values = client.get_all_values(None).await?;

    let mut public_map: HashMap<String, serde_json::Value> = HashMap::new();
    let mut secret_map: HashMap<String, serde_json::Value> = HashMap::new();
    let mut skipped = 0usize;

    for (key, value) in all_values {
        match classify_fn(&key, &value) {
            ClassifyResult::Public => {
                public_map.insert(key, value);
            }
            ClassifyResult::Secret => {
                secret_map.insert(key, value);
            }
            ClassifyResult::Skip => {
                skipped += 1;
            }
        }
    }

    let key_count = public_map.len() + secret_map.len();

    let partitioned = serde_json::json!({
        "public": public_map,
        "secret": secret_map,
    });
    let plaintext = serde_json::to_vec(&partitioned)?;

    let mut key_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key_bytes);
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext_and_tag = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|e| BuildError::Encrypt(e.to_string()))?;

    let mut bundle = Vec::with_capacity(12 + ciphertext_and_tag.len());
    bundle.extend_from_slice(&nonce_bytes);
    bundle.extend_from_slice(&ciphertext_and_tag);

    Ok(BuildBundleResult {
        key_b64: general_purpose::STANDARD.encode(key_bytes),
        bundle,
        key_count,
        skipped_count: skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_from_schema_routes_keys() {
        let classify = classify_from_schema(
            ["pub1".to_string()].into_iter().collect(),
            ["sec1".to_string()].into_iter().collect(),
            ["flag1".to_string()].into_iter().collect(),
        );
        let v = serde_json::Value::Null;
        assert_eq!(classify("pub1", &v), ClassifyResult::Public);
        assert_eq!(classify("sec1", &v), ClassifyResult::Secret);
        assert_eq!(classify("flag1", &v), ClassifyResult::Skip);
        assert_eq!(classify("unknown", &v), ClassifyResult::Public);
    }

    #[test]
    fn default_classify_is_public() {
        let classify = default_classify();
        let v = serde_json::Value::String("x".to_string());
        assert_eq!(classify("anything", &v), ClassifyResult::Public);
    }
}
