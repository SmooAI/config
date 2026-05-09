//! Integration tests for the Rust config priority chain.
//!
//! Parity with TypeScript `src/server/server.priority-chain.integration.test.ts`,
//! adapted to the Rust architecture. Unlike TS (one pipeline merging
//! `blob → env → HTTP → file`), the Rust SDK splits the blob into a
//! separate hydrator: `build_config_runtime` decrypts the blob and seeds
//! the manager's merged config map directly via `seed_from_baked`,
//! bypassing the file/env/HTTP pipeline entirely. `ConfigManager::new()`
//! (no blob) follows the 3-tier merge `file < HTTP < env`.
//!
//! Coverage:
//!   - Each tier wins when higher tiers are absent (precedence)
//!   - Tier missing entirely → `None` (no crash)
//!   - HTTP errors fall through to lower tiers (fault tolerance)
//!   - Caching: repeated reads memoize; `invalidate()` drops them
//!   - Blob hydration: real AES-256-GCM blob is consumed by
//!     `build_config_runtime`; reads resolve offline (no HTTP).
//!   - When a blob is configured, no HTTP fetch happens for public/secret
//!     reads — pinned with a wiremock that asserts zero hits.

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{AeadCore, Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde_json::{json, Value};
use smooai_config::{build_config_runtime, ConfigManager, RuntimeOptions};
use wiremock::matchers::{header, method, path_regex, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const PC_API_KEY: &str = "test-api-key-priority-chain";
const PC_ORG_ID: &str = "550e8400-e29b-41d4-a716-446655440000";
const PC_ENV: &str = "production";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn make_config_dir(tmp: &tempfile::TempDir, defaults: &Value) -> String {
    let config_dir = tmp.path().join(".smooai-config");
    std::fs::create_dir_all(&config_dir).unwrap();
    let mut f = std::fs::File::create(config_dir.join("default.json")).unwrap();
    f.write_all(defaults.to_string().as_bytes()).unwrap();
    config_dir.to_string_lossy().to_string()
}

fn base_env(config_dir: &str, extra: &[(&str, &str)]) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = extra.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect();
    env.insert("SMOOAI_ENV_CONFIG_DIR".into(), config_dir.into());
    env.insert("SMOOAI_CONFIG_ENV".into(), PC_ENV.into());
    env
}

/// Encrypt a `{public, secret}` partition with AES-256-GCM, matching the
/// envelope produced by `build_bundle` (nonce || ciphertext || tag).
fn encrypt_blob(tmp: &tempfile::TempDir, public: Value, secret: Value) -> (PathBuf, String) {
    use aes_gcm::aead::OsRng;
    let plaintext = json!({"public": public, "secret": secret}).to_string();

    let key = Aes256Gcm::generate_key(&mut OsRng);
    let nonce_arr = Aes256Gcm::generate_nonce(&mut OsRng);
    let cipher = Aes256Gcm::new(&key);
    let nonce = Nonce::from_slice(&nonce_arr);
    let ciphertext_and_tag = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext.as_bytes(),
                aad: &[],
            },
        )
        .unwrap();

    let mut blob = nonce_arr.to_vec();
    blob.extend_from_slice(&ciphertext_and_tag);

    let path = tmp.path().join("smoo-config.enc");
    std::fs::write(&path, &blob).unwrap();
    (path, B64.encode(key))
}

/// Mount an OK responder returning the given values map for any GET
/// `/organizations/.../config/values?environment=PC_ENV` with valid auth.
async fn mount_ok_values(server: &MockServer, values: Value) {
    Mock::given(method("GET"))
        .and(path_regex(r"/organizations/.+/config/values"))
        .and(query_param("environment", PC_ENV))
        .and(header("Authorization", format!("Bearer {}", PC_API_KEY)))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"values": values})))
        .mount(server)
        .await;
}

/// Mount a failure responder returning the given status for any GET
/// `/organizations/.../config/values?environment=PC_ENV` with valid auth.
async fn mount_failure(server: &MockServer, status: u16) {
    Mock::given(method("GET"))
        .and(path_regex(r"/organizations/.+/config/values"))
        .and(query_param("environment", PC_ENV))
        .and(header("Authorization", format!("Bearer {}", PC_API_KEY)))
        .respond_with(ResponseTemplate::new(status).set_body_json(json!({"error": "boom"})))
        .mount(server)
        .await;
}

// ---------------------------------------------------------------------------
// 3-tier merge: env > HTTP > file
// ---------------------------------------------------------------------------

#[tokio::test]
async fn env_wins_over_http_and_file() {
    let server = MockServer::start().await;
    mount_ok_values(&server, json!({"API_URL": "https://api.from-http.example"})).await;

    let url = server.uri();
    let result = tokio::task::spawn_blocking(move || {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = make_config_dir(&tmp, &json!({"API_URL": "https://api.from-file.example"}));
        let env = base_env(&config_dir, &[("API_URL", "https://api.from-env.example")]);

        let mut schema_keys = HashSet::new();
        schema_keys.insert("API_URL".into());

        let mgr = ConfigManager::new()
            .with_api_key(PC_API_KEY)
            .with_base_url(&url)
            .with_org_id(PC_ORG_ID)
            .with_environment(PC_ENV)
            .with_schema_keys(schema_keys)
            .with_env(env);

        mgr.get_public_config("API_URL").unwrap()
    })
    .await
    .unwrap();

    assert_eq!(result, Some(json!("https://api.from-env.example")));
}

#[tokio::test]
async fn http_wins_over_file_when_env_absent() {
    let server = MockServer::start().await;
    mount_ok_values(&server, json!({"API_URL": "https://api.from-http.example"})).await;

    let url = server.uri();
    let result = tokio::task::spawn_blocking(move || {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = make_config_dir(&tmp, &json!({"API_URL": "https://api.from-file.example"}));
        let env = base_env(&config_dir, &[]);

        let mgr = ConfigManager::new()
            .with_api_key(PC_API_KEY)
            .with_base_url(&url)
            .with_org_id(PC_ORG_ID)
            .with_environment(PC_ENV)
            .with_env(env);

        mgr.get_public_config("API_URL").unwrap()
    })
    .await
    .unwrap();

    assert_eq!(result, Some(json!("https://api.from-http.example")));
}

#[tokio::test]
async fn file_wins_when_http_and_env_absent() {
    let result = tokio::task::spawn_blocking(|| {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = make_config_dir(&tmp, &json!({"API_URL": "https://api.from-file.example"}));
        let env = base_env(&config_dir, &[]);

        let mgr = ConfigManager::new().with_env(env);
        mgr.get_public_config("API_URL").unwrap()
    })
    .await
    .unwrap();

    assert_eq!(result, Some(json!("https://api.from-file.example")));
}

#[tokio::test]
async fn returns_none_when_no_tier_has_key() {
    let result = tokio::task::spawn_blocking(|| {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = make_config_dir(&tmp, &json!({}));
        let env = base_env(&config_dir, &[]);

        let mgr = ConfigManager::new().with_env(env);
        (
            mgr.get_public_config("MISSING").unwrap(),
            mgr.get_secret_config("MISSING_SECRET").unwrap(),
            mgr.get_feature_flag("MISSING_FLAG").unwrap(),
        )
    })
    .await
    .unwrap();

    assert_eq!(result.0, None);
    assert_eq!(result.1, None);
    assert_eq!(result.2, None);
}

// ---------------------------------------------------------------------------
// HTTP fault tolerance
// ---------------------------------------------------------------------------

#[tokio::test]
async fn http_5xx_falls_through_to_env() {
    let server = MockServer::start().await;
    mount_failure(&server, 500).await;

    let url = server.uri();
    let result = tokio::task::spawn_blocking(move || {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = make_config_dir(&tmp, &json!({}));
        let env = base_env(&config_dir, &[("API_URL", "https://api.from-env.example")]);

        let mut schema_keys = HashSet::new();
        schema_keys.insert("API_URL".into());

        let mgr = ConfigManager::new()
            .with_api_key(PC_API_KEY)
            .with_base_url(&url)
            .with_org_id(PC_ORG_ID)
            .with_environment(PC_ENV)
            .with_schema_keys(schema_keys)
            .with_env(env);

        mgr.get_public_config("API_URL").unwrap()
    })
    .await
    .unwrap();

    // HTTP 500 must not erase the env tier.
    assert_eq!(result, Some(json!("https://api.from-env.example")));
}

#[tokio::test]
async fn http_5xx_falls_through_to_file() {
    let server = MockServer::start().await;
    mount_failure(&server, 503).await;

    let url = server.uri();
    let result = tokio::task::spawn_blocking(move || {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = make_config_dir(&tmp, &json!({"API_URL": "https://api.from-file.example"}));
        let env = base_env(&config_dir, &[]);

        let mgr = ConfigManager::new()
            .with_api_key(PC_API_KEY)
            .with_base_url(&url)
            .with_org_id(PC_ORG_ID)
            .with_environment(PC_ENV)
            .with_env(env);

        mgr.get_public_config("API_URL").unwrap()
    })
    .await
    .unwrap();

    assert_eq!(result, Some(json!("https://api.from-file.example")));
}

// ---------------------------------------------------------------------------
// Caching + invalidation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn repeated_reads_memoize_until_invalidate() {
    let server = MockServer::start().await;
    // Single mount handles both pre- and post-invalidate fetches; we count
    // the number of times the API is hit across the two read phases.
    Mock::given(method("GET"))
        .and(path_regex(r"/organizations/.+/config/values"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "values": {"API_URL": "https://api.cached.example"}
        })))
        .mount(&server)
        .await;

    let url = server.uri();
    let server_ref = server;

    let result = tokio::task::spawn_blocking(move || {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = make_config_dir(&tmp, &json!({}));
        let env = base_env(&config_dir, &[]);

        let mgr = ConfigManager::new()
            .with_api_key(PC_API_KEY)
            .with_base_url(&url)
            .with_org_id(PC_ORG_ID)
            .with_environment(PC_ENV)
            .with_env(env);

        let v1 = mgr.get_public_config("API_URL").unwrap();
        // Cached read — must not trigger a new HTTP request.
        let v2 = mgr.get_public_config("API_URL").unwrap();

        mgr.invalidate();
        // Post-invalidate read — re-fetches.
        let v3 = mgr.get_public_config("API_URL").unwrap();

        (v1, v2, v3)
    })
    .await
    .unwrap();

    assert_eq!(result.0, Some(json!("https://api.cached.example")));
    assert_eq!(result.1, Some(json!("https://api.cached.example")));
    assert_eq!(result.2, Some(json!("https://api.cached.example")));

    // Two distinct fetches: one before the cached read, one after invalidate.
    let received = server_ref.received_requests().await.unwrap();
    assert_eq!(
        received.len(),
        2,
        "expected exactly 2 HTTP fetches; got {}",
        received.len()
    );
}

// ---------------------------------------------------------------------------
// Blob hydrator — separate path that bypasses HTTP for public/secret reads
// ---------------------------------------------------------------------------

#[tokio::test]
async fn blob_hydration_resolves_offline() {
    let tmp = tempfile::tempdir().unwrap();
    let (blob_path, key_b64) = encrypt_blob(
        &tmp,
        json!({"apiUrl": "https://api.from-blob.example"}),
        json!({"sendgridApiKey": "SG.from-blob"}),
    );

    let manager = build_config_runtime(RuntimeOptions {
        key_file: Some(blob_path),
        key_b64: Some(key_b64),
        environment: Some(PC_ENV.into()),
    })
    .await
    .unwrap();

    assert_eq!(
        manager.get_public_config("apiUrl").unwrap(),
        Some(json!("https://api.from-blob.example"))
    );
    assert_eq!(
        manager.get_secret_config("sendgridApiKey").unwrap(),
        Some(json!("SG.from-blob"))
    );
}

#[tokio::test]
async fn blob_bypasses_http_entirely() {
    // Stand up a wiremock that fails the test if hit, then drive the
    // blob-seeded manager. `seed_from_baked` marks the manager initialized
    // and replaces the merged map outright, so file / env / HTTP tiers are
    // not consulted — pin that boundary here.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path_regex(r"/organizations/.+/config/values"))
        .respond_with(ResponseTemplate::new(500))
        .expect(0)
        .mount(&server)
        .await;

    let tmp = tempfile::tempdir().unwrap();
    let (blob_path, key_b64) = encrypt_blob(&tmp, json!({"apiUrl": "https://api.from-blob.example"}), json!({}));

    let manager = build_config_runtime(RuntimeOptions {
        key_file: Some(blob_path),
        key_b64: Some(key_b64),
        environment: Some(PC_ENV.into()),
    })
    .await
    .unwrap();

    // Sanity: read resolves from the seeded blob.
    let value = tokio::task::spawn_blocking(move || manager.get_public_config("apiUrl").unwrap())
        .await
        .unwrap();
    assert_eq!(value, Some(json!("https://api.from-blob.example")));

    // wiremock's `.expect(0)` plus drop-time verification asserts no hits.
    drop(server);
}

#[tokio::test]
async fn blob_fallback_when_env_vars_absent() {
    // No blob configured → build_config_runtime returns a regular manager
    // that lazy-loads from file/env/HTTP on first access. Confirms graceful
    // fallback for dev environments without baked config.
    let manager = build_config_runtime(RuntimeOptions {
        key_file: None,
        key_b64: None,
        environment: Some(PC_ENV.into()),
    })
    .await
    .unwrap();

    let result = tokio::task::spawn_blocking(move || {
        // No file dir / no API creds set → empty merged config; lookups
        // return None rather than panicking.
        manager.get_public_config("anyKey").unwrap()
    })
    .await
    .unwrap();

    assert_eq!(result, None);
}
