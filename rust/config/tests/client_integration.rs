//! Integration tests for the Rust SDK ConfigClient.
//!
//! Uses wiremock to simulate the Smoo AI config API with realistic behavior
//! matching the backend in packages/backend/src/routes/config.

use serde_json::json;
use smooai_config::ConfigClient;
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

// ---------------------------------------------------------------------------
// Test data — mirrors the API contract from packages/backend
// ---------------------------------------------------------------------------

const TEST_API_KEY: &str = "test-api-key-abc123";
const TEST_ORG_ID: &str = "550e8400-e29b-41d4-a716-446655440000";

// ---------------------------------------------------------------------------
// getValue
// ---------------------------------------------------------------------------

#[tokio::test]
async fn get_value_fetches_string() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!("/organizations/{}/config/values/API_URL", TEST_ORG_ID)))
        .and(query_param("environment", "production"))
        .and(header("authorization", format!("Bearer {}", TEST_API_KEY)))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": "https://api.smooai.com"})))
        .expect(1)
        .mount(&server)
        .await;

    let mut client = ConfigClient::new(&server.uri(), TEST_API_KEY, TEST_ORG_ID);
    let val = client.get_value("API_URL", Some("production")).await.unwrap();
    assert_eq!(val, json!("https://api.smooai.com"));
}

#[tokio::test]
async fn get_value_fetches_numeric() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/organizations/{}/config/values/MAX_RETRIES",
            TEST_ORG_ID
        )))
        .and(query_param("environment", "production"))
        .and(header("authorization", format!("Bearer {}", TEST_API_KEY)))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": 3})))
        .expect(1)
        .mount(&server)
        .await;

    let mut client = ConfigClient::new(&server.uri(), TEST_API_KEY, TEST_ORG_ID);
    let val = client.get_value("MAX_RETRIES", Some("production")).await.unwrap();
    assert_eq!(val, json!(3));
}

#[tokio::test]
async fn get_value_fetches_boolean() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/organizations/{}/config/values/ENABLE_NEW_UI",
            TEST_ORG_ID
        )))
        .and(query_param("environment", "production"))
        .and(header("authorization", format!("Bearer {}", TEST_API_KEY)))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": true})))
        .expect(1)
        .mount(&server)
        .await;

    let mut client = ConfigClient::new(&server.uri(), TEST_API_KEY, TEST_ORG_ID);
    let val = client.get_value("ENABLE_NEW_UI", Some("production")).await.unwrap();
    assert_eq!(val, json!(true));
}

#[tokio::test]
async fn get_value_fetches_complex_nested_json() {
    let server = MockServer::start().await;
    let complex = json!({"nested": {"deep": true}, "list": [1, 2, 3]});
    Mock::given(method("GET"))
        .and(path(format!(
            "/organizations/{}/config/values/COMPLEX_VALUE",
            TEST_ORG_ID
        )))
        .and(query_param("environment", "production"))
        .and(header("authorization", format!("Bearer {}", TEST_API_KEY)))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": complex.clone()})))
        .expect(1)
        .mount(&server)
        .await;

    let mut client = ConfigClient::new(&server.uri(), TEST_API_KEY, TEST_ORG_ID);
    let val = client.get_value("COMPLEX_VALUE", Some("production")).await.unwrap();
    assert_eq!(val, complex);
}

#[tokio::test]
async fn get_value_explicit_environment_overrides_default() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!("/organizations/{}/config/values/API_URL", TEST_ORG_ID)))
        .and(query_param("environment", "staging"))
        .and(header("authorization", format!("Bearer {}", TEST_API_KEY)))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": "https://staging-api.smooai.com"})))
        .expect(1)
        .mount(&server)
        .await;

    let mut client = ConfigClient::with_environment(&server.uri(), TEST_API_KEY, TEST_ORG_ID, "production");
    let val = client.get_value("API_URL", Some("staging")).await.unwrap();
    assert_eq!(val, json!("https://staging-api.smooai.com"));
}

#[tokio::test]
async fn get_value_uses_default_environment() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!("/organizations/{}/config/values/API_URL", TEST_ORG_ID)))
        .and(query_param("environment", "development"))
        .and(header("authorization", format!("Bearer {}", TEST_API_KEY)))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": "http://localhost:3000"})))
        .expect(1)
        .mount(&server)
        .await;

    let mut client = ConfigClient::with_environment(&server.uri(), TEST_API_KEY, TEST_ORG_ID, "development");
    let val = client.get_value("API_URL", None).await.unwrap();
    assert_eq!(val, json!("http://localhost:3000"));
}

#[tokio::test]
async fn get_value_error_on_401() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(401).set_body_json(json!({"error": "Unauthorized", "message": "Invalid API key"})),
        )
        .mount(&server)
        .await;

    let mut client = ConfigClient::new(&server.uri(), "bad-key", TEST_ORG_ID);
    let result = client.get_value("API_URL", Some("production")).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn get_value_error_on_404() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(header("authorization", format!("Bearer {}", TEST_API_KEY)))
        .respond_with(
            ResponseTemplate::new(404).set_body_json(json!({"error": "Not found", "message": "Key not found"})),
        )
        .mount(&server)
        .await;

    let mut client = ConfigClient::new(&server.uri(), TEST_API_KEY, TEST_ORG_ID);
    let result = client.get_value("NONEXISTENT", Some("production")).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn get_value_error_on_500() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(500).set_body_json(json!({"error": "Internal server error"})))
        .mount(&server)
        .await;

    let mut client = ConfigClient::new(&server.uri(), TEST_API_KEY, TEST_ORG_ID);
    let result = client.get_value("API_URL", Some("production")).await;
    assert!(result.is_err());
}

// ---------------------------------------------------------------------------
// getAllValues
// ---------------------------------------------------------------------------

#[tokio::test]
async fn get_all_values_fetches_all() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!("/organizations/{}/config/values", TEST_ORG_ID)))
        .and(query_param("environment", "production"))
        .and(header("authorization", format!("Bearer {}", TEST_API_KEY)))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "values": {
                "API_URL": "https://api.smooai.com",
                "MAX_RETRIES": 3,
                "ENABLE_NEW_UI": true
            }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let mut client = ConfigClient::new(&server.uri(), TEST_API_KEY, TEST_ORG_ID);
    let vals = client.get_all_values(Some("production")).await.unwrap();
    assert_eq!(vals.len(), 3);
    assert_eq!(vals["API_URL"], json!("https://api.smooai.com"));
    assert_eq!(vals["MAX_RETRIES"], json!(3));
    assert_eq!(vals["ENABLE_NEW_UI"], json!(true));
}

#[tokio::test]
async fn get_all_values_returns_empty_for_unknown_env() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(query_param("environment", "nonexistent"))
        .and(header("authorization", format!("Bearer {}", TEST_API_KEY)))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"values": {}})))
        .expect(1)
        .mount(&server)
        .await;

    let mut client = ConfigClient::new(&server.uri(), TEST_API_KEY, TEST_ORG_ID);
    let vals = client.get_all_values(Some("nonexistent")).await.unwrap();
    assert!(vals.is_empty());
}

#[tokio::test]
async fn get_all_values_error_on_401() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error": "Unauthorized"})))
        .mount(&server)
        .await;

    let mut client = ConfigClient::new(&server.uri(), "bad-key", TEST_ORG_ID);
    let result = client.get_all_values(Some("production")).await;
    assert!(result.is_err());
}

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

#[tokio::test]
async fn cache_get_value_caches_result() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!("/organizations/{}/config/values/API_URL", TEST_ORG_ID)))
        .and(query_param("environment", "production"))
        .and(header("authorization", format!("Bearer {}", TEST_API_KEY)))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": "https://api.smooai.com"})))
        .expect(1) // Should only be called once thanks to caching
        .mount(&server)
        .await;

    let mut client = ConfigClient::new(&server.uri(), TEST_API_KEY, TEST_ORG_ID);
    let val1 = client.get_value("API_URL", Some("production")).await.unwrap();
    let val2 = client.get_value("API_URL", Some("production")).await.unwrap();
    assert_eq!(val1, json!("https://api.smooai.com"));
    assert_eq!(val2, json!("https://api.smooai.com"));
    // wiremock .expect(1) will verify only 1 request was made
}

#[tokio::test]
async fn cache_per_environment() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(query_param("environment", "production"))
        .and(header("authorization", format!("Bearer {}", TEST_API_KEY)))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": "prod-value"})))
        .expect(1)
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(query_param("environment", "staging"))
        .and(header("authorization", format!("Bearer {}", TEST_API_KEY)))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": "staging-value"})))
        .expect(1)
        .mount(&server)
        .await;

    let mut client = ConfigClient::new(&server.uri(), TEST_API_KEY, TEST_ORG_ID);
    let prod = client.get_value("API_URL", Some("production")).await.unwrap();
    let staging = client.get_value("API_URL", Some("staging")).await.unwrap();

    assert_eq!(prod, json!("prod-value"));
    assert_eq!(staging, json!("staging-value"));
}

#[tokio::test]
async fn cache_get_all_populates_for_get_value() {
    let server = MockServer::start().await;

    // GetAllValues mock
    Mock::given(method("GET"))
        .and(path(format!("/organizations/{}/config/values", TEST_ORG_ID)))
        .and(query_param("environment", "production"))
        .and(header("authorization", format!("Bearer {}", TEST_API_KEY)))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "values": {
                "API_URL": "https://api.smooai.com",
                "MAX_RETRIES": 3
            }
        })))
        .expect(1)
        .mount(&server)
        .await;

    // GetValue mock — should NOT be called since cache is populated
    Mock::given(method("GET"))
        .and(path(format!("/organizations/{}/config/values/API_URL", TEST_ORG_ID)))
        .and(query_param("environment", "production"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": "should-not-fetch"})))
        .expect(0) // Should not be called
        .mount(&server)
        .await;

    let mut client = ConfigClient::new(&server.uri(), TEST_API_KEY, TEST_ORG_ID);
    let _ = client.get_all_values(Some("production")).await.unwrap();

    // Individual getValue should come from cache
    let val = client.get_value("API_URL", Some("production")).await.unwrap();
    assert_eq!(val, json!("https://api.smooai.com"));

    let retries = client.get_value("MAX_RETRIES", Some("production")).await.unwrap();
    assert_eq!(retries, json!(3));
}

#[tokio::test]
async fn cache_invalidate_forces_refetch() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!("/organizations/{}/config/values/API_URL", TEST_ORG_ID)))
        .and(query_param("environment", "production"))
        .and(header("authorization", format!("Bearer {}", TEST_API_KEY)))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": "https://api.smooai.com"})))
        .expect(2) // Called twice: initial fetch + after invalidation
        .mount(&server)
        .await;

    let mut client = ConfigClient::new(&server.uri(), TEST_API_KEY, TEST_ORG_ID);

    let _ = client.get_value("API_URL", Some("production")).await.unwrap();
    client.invalidate_cache();
    let val = client.get_value("API_URL", Some("production")).await.unwrap();
    assert_eq!(val, json!("https://api.smooai.com"));
}

// ---------------------------------------------------------------------------
// Full workflow
// ---------------------------------------------------------------------------

#[tokio::test]
async fn full_workflow_fetch_all_read_individual_invalidate() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path(format!("/organizations/{}/config/values", TEST_ORG_ID)))
        .and(query_param("environment", "production"))
        .and(header("authorization", format!("Bearer {}", TEST_API_KEY)))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "values": {
                "API_URL": "https://api.smooai.com",
                "DATABASE_URL": "postgres://prod:secret@db.smooai.com/prod",
                "MAX_RETRIES": 3
            }
        })))
        .expect(1)
        .mount(&server)
        .await;

    // After invalidation, individual getValue will be called
    Mock::given(method("GET"))
        .and(path(format!("/organizations/{}/config/values/API_URL", TEST_ORG_ID)))
        .and(query_param("environment", "production"))
        .and(header("authorization", format!("Bearer {}", TEST_API_KEY)))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": "https://api.smooai.com"})))
        .expect(1)
        .mount(&server)
        .await;

    let mut client = ConfigClient::new(&server.uri(), TEST_API_KEY, TEST_ORG_ID);

    // 1. Fetch all
    let vals = client.get_all_values(Some("production")).await.unwrap();
    assert_eq!(vals.len(), 3);

    // 2. Read from cache (no new requests)
    let url = client.get_value("API_URL", Some("production")).await.unwrap();
    assert_eq!(url, json!("https://api.smooai.com"));

    let db = client.get_value("DATABASE_URL", Some("production")).await.unwrap();
    assert_eq!(db, json!("postgres://prod:secret@db.smooai.com/prod"));

    // 3. Invalidate and re-fetch
    client.invalidate_cache();
    let url2 = client.get_value("API_URL", Some("production")).await.unwrap();
    assert_eq!(url2, json!("https://api.smooai.com"));
}

#[tokio::test]
async fn full_workflow_multi_environment() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path(format!("/organizations/{}/config/values/API_URL", TEST_ORG_ID)))
        .and(query_param("environment", "production"))
        .and(header("authorization", format!("Bearer {}", TEST_API_KEY)))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": "https://api.smooai.com"})))
        .expect(1)
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path(format!("/organizations/{}/config/values/API_URL", TEST_ORG_ID)))
        .and(query_param("environment", "staging"))
        .and(header("authorization", format!("Bearer {}", TEST_API_KEY)))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": "https://staging-api.smooai.com"})))
        .expect(1)
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path(format!("/organizations/{}/config/values/API_URL", TEST_ORG_ID)))
        .and(query_param("environment", "development"))
        .and(header("authorization", format!("Bearer {}", TEST_API_KEY)))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": "http://localhost:3000"})))
        .expect(1)
        .mount(&server)
        .await;

    let mut client = ConfigClient::new(&server.uri(), TEST_API_KEY, TEST_ORG_ID);

    let prod = client.get_value("API_URL", Some("production")).await.unwrap();
    let staging = client.get_value("API_URL", Some("staging")).await.unwrap();
    let dev = client.get_value("API_URL", Some("development")).await.unwrap();

    assert_eq!(prod, json!("https://api.smooai.com"));
    assert_eq!(staging, json!("https://staging-api.smooai.com"));
    assert_eq!(dev, json!("http://localhost:3000"));

    // Re-read from cache — expect counts verified by wiremock .expect(1)
    let _ = client.get_value("API_URL", Some("production")).await.unwrap();
    let _ = client.get_value("API_URL", Some("staging")).await.unwrap();
    let _ = client.get_value("API_URL", Some("development")).await.unwrap();
}

// ===========================================================================
// Environment-specific cache invalidation
// ===========================================================================

#[tokio::test]
async fn invalidate_env_clears_only_target() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path(format!("/organizations/{TEST_ORG_ID}/config/values/API_URL")))
        .and(query_param("environment", "production"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": "prod-url"})))
        .expect(2) // Called twice: once initially, once after env invalidation
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path(format!("/organizations/{TEST_ORG_ID}/config/values/API_URL")))
        .and(query_param("environment", "staging"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": "staging-url"})))
        .expect(1) // Only called once — stays cached
        .mount(&server)
        .await;

    let mut client = ConfigClient::with_environment(&server.uri(), TEST_API_KEY, TEST_ORG_ID, "development");

    let _ = client.get_value("API_URL", Some("production")).await.unwrap();
    let _ = client.get_value("API_URL", Some("staging")).await.unwrap();

    client.invalidate_cache_for_environment("production");

    // Production re-fetched
    let prod = client.get_value("API_URL", Some("production")).await.unwrap();
    assert_eq!(prod, json!("prod-url"));

    // Staging still cached
    let staging = client.get_value("API_URL", Some("staging")).await.unwrap();
    assert_eq!(staging, json!("staging-url"));
}

#[tokio::test]
async fn invalidate_env_noop_for_nonexistent() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path(format!("/organizations/{TEST_ORG_ID}/config/values/API_URL")))
        .and(query_param("environment", "production"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": "prod-url"})))
        .expect(1) // Only called once — nonexistent env invalidation doesn't affect it
        .mount(&server)
        .await;

    let mut client = ConfigClient::with_environment(&server.uri(), TEST_API_KEY, TEST_ORG_ID, "development");
    let _ = client.get_value("API_URL", Some("production")).await.unwrap();

    client.invalidate_cache_for_environment("nonexistent");

    // Production still cached
    let val = client.get_value("API_URL", Some("production")).await.unwrap();
    assert_eq!(val, json!("prod-url"));
}
