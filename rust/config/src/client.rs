//! Runtime configuration client for fetching values from the Smoo AI server.
//!
//! # Environment Variables
//!
//! The client can be configured via environment variables when using [`ConfigClient::from_env`]:
//! - `SMOOAI_CONFIG_API_URL` — Base URL of the config API
//! - `SMOOAI_CONFIG_API_KEY` — Bearer token for authentication
//! - `SMOOAI_CONFIG_ORG_ID` — Organization ID
//! - `SMOOAI_CONFIG_ENV` — Default environment name (e.g. "production")

use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use reqwest::Client;
use serde::Deserialize;
use std::collections::HashMap;
use std::env;
use std::time::{Duration, Instant};

/// Characters to percent-encode in URL path segments.
/// Encodes everything except unreserved characters (RFC 3986): A-Z a-z 0-9 - . _ ~
const PATH_SEGMENT_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'/')
    .add(b':')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'@')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

/// Client for reading configuration values from the Smoo AI config server.
pub struct ConfigClient {
    base_url: String,
    org_id: String,
    default_environment: String,
    cache_ttl: Option<Duration>,
    client: Client,
    cache: HashMap<String, CacheEntry>,
}

struct CacheEntry {
    value: serde_json::Value,
    expires_at: Option<Instant>,
}

#[derive(Deserialize)]
struct ValueResponse {
    value: serde_json::Value,
}

#[derive(Deserialize)]
struct ValuesResponse {
    values: HashMap<String, serde_json::Value>,
}

impl ConfigClient {
    /// Create a new config client with explicit parameters.
    pub fn new(base_url: &str, api_key: &str, org_id: &str) -> Self {
        let default_env = env::var("SMOOAI_CONFIG_ENV").unwrap_or_else(|_| "development".to_string());
        Self::with_environment(base_url, api_key, org_id, &default_env)
    }

    /// Create a new config client with an explicit default environment.
    pub fn with_environment(base_url: &str, api_key: &str, org_id: &str, environment: &str) -> Self {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", api_key).parse().unwrap(),
        );

        let client = Client::builder().default_headers(headers).build().unwrap();

        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            org_id: org_id.to_string(),
            default_environment: environment.to_string(),
            cache_ttl: None,
            client,
            cache: HashMap::new(),
        }
    }

    /// Set the cache TTL duration. `None` means cache never expires (manual invalidation only).
    pub fn set_cache_ttl(&mut self, ttl: Option<Duration>) {
        self.cache_ttl = ttl;
    }

    /// Create a config client from environment variables.
    ///
    /// Reads `SMOOAI_CONFIG_API_URL`, `SMOOAI_CONFIG_API_KEY`, `SMOOAI_CONFIG_ORG_ID`,
    /// and optionally `SMOOAI_CONFIG_ENV` (defaults to "development").
    ///
    /// # Panics
    /// Panics if any required environment variable is missing.
    pub fn from_env() -> Self {
        let base_url = env::var("SMOOAI_CONFIG_API_URL").expect("SMOOAI_CONFIG_API_URL must be set");
        let api_key = env::var("SMOOAI_CONFIG_API_KEY").expect("SMOOAI_CONFIG_API_KEY must be set");
        let org_id = env::var("SMOOAI_CONFIG_ORG_ID").expect("SMOOAI_CONFIG_ORG_ID must be set");

        Self::new(&base_url, &api_key, &org_id)
    }

    fn resolve_env<'a>(&'a self, environment: Option<&'a str>) -> &'a str {
        match environment {
            Some(e) if !e.is_empty() => e,
            _ => &self.default_environment,
        }
    }

    fn compute_expires_at(&self) -> Option<Instant> {
        self.cache_ttl.map(|ttl| Instant::now() + ttl)
    }

    fn get_cached(&self, cache_key: &str) -> Option<serde_json::Value> {
        let entry = self.cache.get(cache_key)?;
        if let Some(expires_at) = entry.expires_at {
            if Instant::now() > expires_at {
                return None;
            }
        }
        Some(entry.value.clone())
    }

    /// Get a single config value.
    /// Pass `None` for environment to use the default.
    pub async fn get_value(
        &mut self,
        key: &str,
        environment: Option<&str>,
    ) -> Result<serde_json::Value, reqwest::Error> {
        let env = self.resolve_env(environment).to_string();
        let cache_key = format!("{}:{}", env, key);

        if let Some(cached) = self.get_cached(&cache_key) {
            return Ok(cached);
        }

        // Remove expired entry if still in map
        if self.cache.contains_key(&cache_key) {
            self.cache.remove(&cache_key);
        }

        let encoded_key = utf8_percent_encode(key, PATH_SEGMENT_ENCODE_SET).to_string();

        let response: ValueResponse = self
            .client
            .get(format!(
                "{}/organizations/{}/config/values/{}",
                self.base_url, self.org_id, encoded_key
            ))
            .query(&[("environment", &env)])
            .send()
            .await?
            .json()
            .await?;

        let expires_at = self.compute_expires_at();
        self.cache.insert(
            cache_key,
            CacheEntry {
                value: response.value.clone(),
                expires_at,
            },
        );
        Ok(response.value)
    }

    /// Get all config values for an environment.
    /// Pass `None` for environment to use the default.
    pub async fn get_all_values(
        &mut self,
        environment: Option<&str>,
    ) -> Result<HashMap<String, serde_json::Value>, reqwest::Error> {
        let env = self.resolve_env(environment).to_string();

        let response: ValuesResponse = self
            .client
            .get(format!("{}/organizations/{}/config/values", self.base_url, self.org_id))
            .query(&[("environment", &env)])
            .send()
            .await?
            .json()
            .await?;

        let expires_at = self.compute_expires_at();
        for (key, value) in &response.values {
            self.cache.insert(
                format!("{}:{}", env, key),
                CacheEntry {
                    value: value.clone(),
                    expires_at,
                },
            );
        }

        Ok(response.values)
    }

    /// Clear the entire local cache.
    pub fn invalidate_cache(&mut self) {
        self.cache.clear();
    }

    /// Clear cached values for a specific environment.
    pub fn invalidate_cache_for_environment(&mut self, environment: &str) {
        let prefix = format!("{}:", environment);
        self.cache.retain(|key, _| !key.starts_with(&prefix));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_trims_trailing_slash() {
        let client = ConfigClient::new("https://api.example.com/", "key", "org-id");
        assert_eq!(client.base_url, "https://api.example.com");
    }

    #[test]
    fn test_new_preserves_url_without_trailing_slash() {
        let client = ConfigClient::new("https://api.example.com", "key", "org-id");
        assert_eq!(client.base_url, "https://api.example.com");
    }

    #[test]
    fn test_new_stores_org_id() {
        let client = ConfigClient::new("https://api.example.com", "key", "my-org-123");
        assert_eq!(client.org_id, "my-org-123");
    }

    #[test]
    fn test_new_initializes_empty_cache() {
        let client = ConfigClient::new("https://api.example.com", "key", "org");
        assert!(client.cache.is_empty());
    }

    #[test]
    fn test_invalidate_cache_clears_all() {
        let mut client = ConfigClient::new("https://api.example.com", "key", "org");
        client.cache.insert(
            "prod:KEY".to_string(),
            CacheEntry {
                value: serde_json::json!("value"),
                expires_at: None,
            },
        );
        client.cache.insert(
            "staging:KEY".to_string(),
            CacheEntry {
                value: serde_json::json!(42),
                expires_at: None,
            },
        );

        assert_eq!(client.cache.len(), 2);
        client.invalidate_cache();
        assert!(client.cache.is_empty());
    }

    #[test]
    fn test_invalidate_empty_cache_is_noop() {
        let mut client = ConfigClient::new("https://api.example.com", "key", "org");
        client.invalidate_cache();
        assert!(client.cache.is_empty());
    }

    #[test]
    fn test_invalidate_cache_for_environment() {
        let mut client = ConfigClient::new("https://api.example.com", "key", "org");
        client.cache.insert(
            "prod:KEY1".to_string(),
            CacheEntry {
                value: serde_json::json!("v1"),
                expires_at: None,
            },
        );
        client.cache.insert(
            "prod:KEY2".to_string(),
            CacheEntry {
                value: serde_json::json!("v2"),
                expires_at: None,
            },
        );
        client.cache.insert(
            "staging:KEY1".to_string(),
            CacheEntry {
                value: serde_json::json!("sv1"),
                expires_at: None,
            },
        );

        client.invalidate_cache_for_environment("prod");
        assert_eq!(client.cache.len(), 1);
        assert!(client.cache.contains_key("staging:KEY1"));
    }

    #[test]
    fn test_cache_ttl_none_by_default() {
        let client = ConfigClient::new("https://api.example.com", "key", "org");
        assert!(client.cache_ttl.is_none());
    }

    #[test]
    fn test_set_cache_ttl() {
        let mut client = ConfigClient::new("https://api.example.com", "key", "org");
        client.set_cache_ttl(Some(Duration::from_secs(60)));
        assert_eq!(client.cache_ttl, Some(Duration::from_secs(60)));
    }

    #[test]
    fn test_value_response_deserialization() {
        let json = r#"{"value": "hello"}"#;
        let resp: ValueResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.value, serde_json::json!("hello"));
    }

    #[test]
    fn test_value_response_complex_value() {
        let json = r#"{"value": {"nested": true, "count": 42}}"#;
        let resp: ValueResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.value["nested"], true);
        assert_eq!(resp.value["count"], 42);
    }

    #[test]
    fn test_values_response_deserialization() {
        let json = r#"{"values": {"KEY1": "val1", "KEY2": 42}}"#;
        let resp: ValuesResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.values.len(), 2);
        assert_eq!(resp.values["KEY1"], serde_json::json!("val1"));
        assert_eq!(resp.values["KEY2"], serde_json::json!(42));
    }

    #[test]
    fn test_values_response_empty() {
        let json = r#"{"values": {}}"#;
        let resp: ValuesResponse = serde_json::from_str(json).unwrap();
        assert!(resp.values.is_empty());
    }

    #[test]
    fn test_default_environment() {
        let client = ConfigClient::with_environment("https://api.example.com", "key", "org", "production");
        assert_eq!(client.default_environment, "production");
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use std::time::Duration;
    use wiremock::matchers::{header, method, path_regex, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    // --- Test 1: get_value fetches a single value correctly ---
    #[tokio::test]
    async fn test_get_value_fetches_single_value() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path_regex(r"/organizations/.+/config/values/.+"))
            .and(query_param("environment", "production"))
            .and(header("Authorization", "Bearer test-api-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"value": "hello-world"})))
            .expect(1)
            .mount(&mock_server)
            .await;

        let mut client = ConfigClient::with_environment(&mock_server.uri(), "test-api-key", "test-org", "production");
        let value = client.get_value("MY_KEY", None).await.unwrap();
        assert_eq!(value, serde_json::json!("hello-world"));
    }

    // --- Test 2: get_all_values fetches all values correctly ---
    #[tokio::test]
    async fn test_get_all_values_fetches_all() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path_regex(r"/organizations/.+/config/values$"))
            .and(query_param("environment", "staging"))
            .and(header("Authorization", "Bearer test-api-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "values": {
                    "DB_HOST": "db.example.com",
                    "DB_PORT": 5432,
                    "FEATURE_FLAG": true
                }
            })))
            .expect(1)
            .mount(&mock_server)
            .await;

        let mut client = ConfigClient::with_environment(&mock_server.uri(), "test-api-key", "test-org", "staging");
        let values = client.get_all_values(None).await.unwrap();

        assert_eq!(values.len(), 3);
        assert_eq!(values["DB_HOST"], serde_json::json!("db.example.com"));
        assert_eq!(values["DB_PORT"], serde_json::json!(5432));
        assert_eq!(values["FEATURE_FLAG"], serde_json::json!(true));
    }

    // --- Test 3: Authorization header is sent correctly ---
    #[tokio::test]
    async fn test_auth_header_verification() {
        let mock_server = MockServer::start().await;

        // Mock expects a specific bearer token
        Mock::given(method("GET"))
            .and(path_regex(r"/organizations/.+/config/values/.+"))
            .and(header("Authorization", "Bearer my-secret-token-xyz"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"value": "authenticated"})))
            .expect(1)
            .mount(&mock_server)
            .await;

        let mut client =
            ConfigClient::with_environment(&mock_server.uri(), "my-secret-token-xyz", "org-123", "production");
        let value = client.get_value("SECRET_KEY", None).await.unwrap();
        assert_eq!(value, serde_json::json!("authenticated"));
    }

    // --- Test 4: Caching — second call to same key doesn't hit server ---
    #[tokio::test]
    async fn test_caching_prevents_duplicate_requests() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path_regex(r"/organizations/.+/config/values/.+"))
            .and(query_param("environment", "production"))
            .and(header("Authorization", "Bearer test-api-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"value": "cached-value"})))
            .expect(1) // Server should only be hit once
            .mount(&mock_server)
            .await;

        let mut client = ConfigClient::with_environment(&mock_server.uri(), "test-api-key", "test-org", "production");

        // First call — hits the server
        let value1 = client.get_value("CACHE_KEY", None).await.unwrap();
        assert_eq!(value1, serde_json::json!("cached-value"));

        // Second call — served from cache, no server hit
        let value2 = client.get_value("CACHE_KEY", None).await.unwrap();
        assert_eq!(value2, serde_json::json!("cached-value"));
    }

    // --- Test 5: TTL expiration causes re-fetch from server ---
    #[tokio::test]
    async fn test_ttl_expiration_refetches() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path_regex(r"/organizations/.+/config/values/.+"))
            .and(query_param("environment", "production"))
            .and(header("Authorization", "Bearer test-api-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"value": "fresh-value"})))
            .expect(2) // Server should be hit twice: initial + after TTL expiry
            .mount(&mock_server)
            .await;

        let mut client = ConfigClient::with_environment(&mock_server.uri(), "test-api-key", "test-org", "production");
        // Set a very short TTL so it expires quickly
        client.set_cache_ttl(Some(Duration::from_millis(1)));

        // First call — hits the server
        let value1 = client.get_value("TTL_KEY", None).await.unwrap();
        assert_eq!(value1, serde_json::json!("fresh-value"));

        // Wait for TTL to expire
        tokio::time::sleep(Duration::from_millis(50)).await;

        // Second call — cache expired, hits the server again
        let value2 = client.get_value("TTL_KEY", None).await.unwrap();
        assert_eq!(value2, serde_json::json!("fresh-value"));
    }

    // --- Test 6: invalidate_cache forces re-fetch ---
    #[tokio::test]
    async fn test_invalidate_cache_forces_refetch() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path_regex(r"/organizations/.+/config/values/.+"))
            .and(query_param("environment", "production"))
            .and(header("Authorization", "Bearer test-api-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"value": "refetched"})))
            .expect(2) // Server hit twice: initial + after invalidation
            .mount(&mock_server)
            .await;

        let mut client = ConfigClient::with_environment(&mock_server.uri(), "test-api-key", "test-org", "production");

        // First call — hits the server
        let value1 = client.get_value("INVAL_KEY", None).await.unwrap();
        assert_eq!(value1, serde_json::json!("refetched"));

        // Invalidate cache
        client.invalidate_cache();

        // Second call — cache cleared, hits the server again
        let value2 = client.get_value("INVAL_KEY", None).await.unwrap();
        assert_eq!(value2, serde_json::json!("refetched"));
    }

    // --- Test 7: Error handling — server returns 401 ---
    #[tokio::test]
    async fn test_error_handling_401_unauthorized() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path_regex(r"/organizations/.+/config/values/.+"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "error": "Unauthorized"
            })))
            .expect(1)
            .mount(&mock_server)
            .await;

        let mut client = ConfigClient::with_environment(&mock_server.uri(), "bad-api-key", "test-org", "production");

        let result = client.get_value("SOME_KEY", None).await;
        assert!(result.is_err(), "Expected error for 401 response");
    }

    // --- Test 8: Error handling — server returns 404 ---
    #[tokio::test]
    async fn test_error_handling_404_not_found() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path_regex(r"/organizations/.+/config/values/.+"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
                "error": "Not found"
            })))
            .expect(1)
            .mount(&mock_server)
            .await;

        let mut client = ConfigClient::with_environment(&mock_server.uri(), "test-api-key", "test-org", "production");

        let result = client.get_value("NONEXISTENT_KEY", None).await;
        assert!(result.is_err(), "Expected error for 404 response");
    }

    // --- Test 9: Per-environment caching — different envs are separate cache entries ---
    #[tokio::test]
    async fn test_per_environment_caching() {
        let mock_server = MockServer::start().await;

        // Mock for production environment
        Mock::given(method("GET"))
            .and(path_regex(r"/organizations/.+/config/values/.+"))
            .and(query_param("environment", "production"))
            .and(header("Authorization", "Bearer test-api-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"value": "prod-value"})))
            .expect(1)
            .mount(&mock_server)
            .await;

        // Mock for staging environment
        Mock::given(method("GET"))
            .and(path_regex(r"/organizations/.+/config/values/.+"))
            .and(query_param("environment", "staging"))
            .and(header("Authorization", "Bearer test-api-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"value": "staging-value"})))
            .expect(1)
            .mount(&mock_server)
            .await;

        let mut client = ConfigClient::with_environment(&mock_server.uri(), "test-api-key", "test-org", "production");

        // Fetch for production (default env)
        let prod_value = client.get_value("SHARED_KEY", None).await.unwrap();
        assert_eq!(prod_value, serde_json::json!("prod-value"));

        // Fetch for staging (explicit env override)
        let staging_value = client.get_value("SHARED_KEY", Some("staging")).await.unwrap();
        assert_eq!(staging_value, serde_json::json!("staging-value"));

        // Fetch production again — should come from cache (mock expects only 1 call)
        let prod_cached = client.get_value("SHARED_KEY", None).await.unwrap();
        assert_eq!(prod_cached, serde_json::json!("prod-value"));

        // Fetch staging again — should come from cache (mock expects only 1 call)
        let staging_cached = client.get_value("SHARED_KEY", Some("staging")).await.unwrap();
        assert_eq!(staging_cached, serde_json::json!("staging-value"));
    }
}
