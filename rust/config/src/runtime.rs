//! Bake-aware runtime hydrator for smooai-config (Rust parity with TypeScript/Python).
//!
//! Reads a pre-encrypted JSON blob produced by [`crate::build`] and exposes
//! typed sync accessors by seeding a [`ConfigClient`] cache. The library API
//! stays uniform — consumers always call `client.get_value(key)` regardless
//! of whether the data came from the baked blob or a live fetch.
//!
//! - Public + secret values hydrate from the blob (sync, no network)
//! - Feature flags are never baked — the baker drops them so they stay
//!   live-fetched through [`ConfigClient`].
//!
//! Works anywhere Rust runs with a filesystem: Lambda, ECS, Fargate, EC2,
//! long-lived services, containers.
//!
//! Environment variables (set by the deploy pipeline):
//!
//!   `SMOO_CONFIG_KEY_FILE` — absolute path to the encrypted blob on disk
//!   `SMOO_CONFIG_KEY`      — base64-encoded 32-byte AES-256 key
//!
//!   `SMOOAI_CONFIG_API_URL` — for feature-flag lookups (via ConfigClient)
//!   `SMOOAI_CONFIG_API_KEY`
//!   `SMOOAI_CONFIG_ORG_ID`
//!   `SMOOAI_CONFIG_ENV`
//!
//! Blob layout (matches TypeScript + Python):
//!   `nonce (12 bytes) || ciphertext || authTag (16 bytes)`

use std::collections::HashMap;
use std::env;
use std::fs;
use std::sync::OnceLock;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose, Engine as _};
use serde::Deserialize;

use crate::client::ConfigClient;

#[derive(Debug, Deserialize)]
pub struct BakedBlob {
    #[serde(default)]
    pub public: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub secret: HashMap<String, serde_json::Value>,
}

#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error("SMOO_CONFIG_KEY must decode to 32 bytes (got {0})")]
    BadKeyLength(usize),
    #[error("smoo-config blob too short ({0} bytes)")]
    BlobTooShort(usize),
    #[error("AES-GCM decrypt failed: {0}")]
    Decrypt(String),
    #[error("failed to parse decrypted blob: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("base64 decode error: {0}")]
    Base64(#[from] base64::DecodeError),
}

static BLOB_CACHE: OnceLock<Option<BakedBlob>> = OnceLock::new();

fn decrypt_blob_once() -> Result<Option<BakedBlob>, RuntimeError> {
    let key_file = match env::var("SMOO_CONFIG_KEY_FILE") {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let key_b64 = match env::var("SMOO_CONFIG_KEY") {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };

    let key = general_purpose::STANDARD.decode(key_b64.as_bytes())?;
    if key.len() != 32 {
        return Err(RuntimeError::BadKeyLength(key.len()));
    }

    let blob = fs::read(&key_file)?;
    if blob.len() < 28 {
        return Err(RuntimeError::BlobTooShort(blob.len()));
    }

    let nonce_bytes = &blob[..12];
    let ciphertext_and_tag = &blob[12..];

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext_and_tag)
        .map_err(|e| RuntimeError::Decrypt(e.to_string()))?;

    let parsed: BakedBlob = serde_json::from_slice(&plaintext)?;
    Ok(Some(parsed))
}

/// Decrypt the baked blob once and cache the result for the process lifetime.
///
/// Returns `Ok(None)` when no blob is present (env vars unset). Call this
/// when you need the raw `{public, secret}` map; most consumers should use
/// [`hydrate_config_client`] or [`build_config_runtime`].
///
/// The cache is per-process; tests should construct fresh clients and bypass
/// the cache by calling the private decrypt path via setting env vars.
pub fn read_baked_config() -> Result<Option<&'static BakedBlob>, RuntimeError> {
    let cached = BLOB_CACHE.get_or_init(|| decrypt_blob_once().ok().flatten());
    Ok(cached.as_ref())
}

/// Seed a [`ConfigClient`]'s cache from the baked blob.
///
/// After this call, `client.get_value(key)` resolves public + secret keys
/// from the in-memory cache (no HTTP). Feature flags keep live-fetch
/// semantics because the baker omits them from the blob.
///
/// Returns the number of keys seeded (0 when no blob is present).
pub fn hydrate_config_client(client: &mut ConfigClient, environment: Option<&str>) -> Result<usize, RuntimeError> {
    let blob = match read_baked_config()? {
        Some(b) => b,
        None => return Ok(0),
    };
    let mut merged: HashMap<String, serde_json::Value> = HashMap::new();
    for (k, v) in &blob.public {
        merged.insert(k.clone(), v.clone());
    }
    for (k, v) in &blob.secret {
        merged.insert(k.clone(), v.clone());
    }
    let count = merged.len();
    client.seed_cache_from_map(merged, environment);
    Ok(count)
}

/// Build a [`ConfigClient`] from env vars and hydrate it with the baked blob.
///
/// Public + secret values resolve sync-fast (no HTTP) via `get_value`.
/// Feature flags hit the live API with the client's cache TTL.
///
/// # Panics
/// Panics if the required env vars for `ConfigClient::from_env` are not set.
pub fn build_config_runtime(flag_cache_ttl: Option<std::time::Duration>) -> Result<ConfigClient, RuntimeError> {
    let mut client = ConfigClient::from_env();
    client.set_cache_ttl(flag_cache_ttl);
    hydrate_config_client(&mut client, None)?;
    Ok(client)
}
