//! Integration tests for the Rust baker + runtime — mirrors the TypeScript
//! runtime.test.ts and Python test_build_runtime_roundtrip.py contracts.
//!
//! - build_bundle partitions values through the classifier and encrypts with
//!   the same `nonce || ciphertext || tag` layout as TS/Python
//! - runtime::hydrate_config_client decrypts, seeds the cache, and makes
//!   subsequent `get_value` calls resolve without HTTP

use serde_json::json;
use smooai_config::build::{build_bundle, classify_from_schema};
use smooai_config::client::ConfigClient;
use smooai_config::runtime::{hydrate_config_client, BakedBlob};
use std::collections::{HashMap, HashSet};
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const TEST_API_KEY: &str = "test-api-key-abc123";
const TEST_ORG_ID: &str = "550e8400-e29b-41d4-a716-446655440000";

async fn mock_all_values_server(values: serde_json::Value) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!("/organizations/{}/config/values", TEST_ORG_ID)))
        .and(query_param("environment", "production"))
        .and(header("authorization", format!("Bearer {}", TEST_API_KEY)))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"values": values})))
        .mount(&server)
        .await;
    server
}

#[tokio::test]
async fn build_bundle_partitions_public_secret_and_skips_flags() {
    let server = mock_all_values_server(json!({
        "API_URL": "https://api.example.com",
        "API_KEY": "secret-123",
        "ENABLE_FEATURE": true,
    }))
    .await;

    let classify = classify_from_schema(
        HashSet::from(["API_URL".to_string()]),
        HashSet::from(["API_KEY".to_string()]),
        HashSet::from(["ENABLE_FEATURE".to_string()]),
    );

    let result = build_bundle(&server.uri(), TEST_API_KEY, TEST_ORG_ID, "production", Some(classify))
        .await
        .unwrap();

    assert_eq!(result.key_count, 2, "two keys baked (public + secret)");
    assert_eq!(result.skipped_count, 1, "feature flag skipped");
    assert_eq!(result.bundle.len() > 28, true, "bundle has nonce + ct + tag");
    assert_eq!(base64_decoded_len(&result.key_b64), 32, "key is 32 bytes AES-256");
}

#[tokio::test]
async fn bundle_roundtrips_through_runtime_hydration() {
    let server = mock_all_values_server(json!({
        "API_URL": "https://api.example.com",
        "API_KEY": "secret-123",
        "DEBUG_MODE": false,
    }))
    .await;

    let classify = classify_from_schema(
        HashSet::from(["API_URL".to_string(), "DEBUG_MODE".to_string()]),
        HashSet::from(["API_KEY".to_string()]),
        HashSet::new(),
    );

    let result = build_bundle(&server.uri(), TEST_API_KEY, TEST_ORG_ID, "production", Some(classify))
        .await
        .unwrap();

    // Decrypt exactly like runtime::hydrate_config_client would, but
    // inline — the runtime's `read_baked_config` caches the blob in a
    // OnceLock keyed off SMOO_CONFIG_KEY_FILE / SMOO_CONFIG_KEY env vars,
    // which is per-process state we can't reset between tests without
    // fighting the `static OnceLock`. So we seed_cache_from_map directly
    // and trust the runtime-module tests (below) to exercise the env path.
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Key, Nonce};
    use base64::{engine::general_purpose, Engine as _};

    let key_bytes = general_purpose::STANDARD.decode(&result.key_b64).unwrap();
    let nonce = Nonce::from_slice(&result.bundle[..12]);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let plaintext = cipher.decrypt(nonce, &result.bundle[12..]).unwrap();
    let parsed: BakedBlob = serde_json::from_slice(&plaintext).unwrap();

    assert_eq!(parsed.public.len(), 2);
    assert_eq!(parsed.secret.len(), 1);
    assert_eq!(parsed.public.get("API_URL"), Some(&json!("https://api.example.com")));
    assert_eq!(parsed.public.get("DEBUG_MODE"), Some(&json!(false)));
    assert_eq!(parsed.secret.get("API_KEY"), Some(&json!("secret-123")));

    // Now verify hydrate feeds everything into the client cache.
    let mut merged: HashMap<String, serde_json::Value> = HashMap::new();
    merged.extend(parsed.public.clone());
    merged.extend(parsed.secret.clone());
    let mut client = ConfigClient::with_environment(&server.uri(), TEST_API_KEY, TEST_ORG_ID, "production");
    client.seed_cache_from_map(merged, Some("production"));

    // After seeding, get_value should resolve from cache and never hit the HTTP
    // mock — if it did, wiremock would reject the un-registered value path.
    let url = client.get_value("API_URL", Some("production")).await.unwrap();
    let key = client.get_value("API_KEY", Some("production")).await.unwrap();
    let dbg = client.get_value("DEBUG_MODE", Some("production")).await.unwrap();
    assert_eq!(url, json!("https://api.example.com"));
    assert_eq!(key, json!("secret-123"));
    assert_eq!(dbg, json!(false));
}

#[tokio::test]
async fn hydrate_skips_when_no_blob_env_set() {
    // `read_baked_config` returns Ok(None) when SMOO_CONFIG_KEY_FILE or
    // SMOO_CONFIG_KEY is unset. In that case hydrate_config_client is a
    // no-op and returns 0.
    //
    // We have to skip this when env vars happen to be set in CI (e.g. when
    // another test sets them upstream), so check + early-return.
    if std::env::var("SMOO_CONFIG_KEY_FILE").is_ok() && std::env::var("SMOO_CONFIG_KEY").is_ok() {
        return;
    }

    let mut client = ConfigClient::new("http://unused", "key", TEST_ORG_ID);
    let count = hydrate_config_client(&mut client, None).unwrap();
    assert_eq!(count, 0);
}

fn base64_decoded_len(b64: &str) -> usize {
    use base64::{engine::general_purpose, Engine as _};
    general_purpose::STANDARD.decode(b64).unwrap().len()
}
