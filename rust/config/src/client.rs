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
