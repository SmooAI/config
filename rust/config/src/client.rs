//! Runtime configuration client for fetching values from the Smoo AI server.
//!
//! # Environment Variables
//!
//! The client can be configured via environment variables when using [`ConfigClient::from_env`]:
//! - `SMOOAI_CONFIG_API_URL` — Base URL of the config API
//! - `SMOOAI_CONFIG_API_KEY` — Bearer token for authentication
//! - `SMOOAI_CONFIG_ORG_ID` — Organization ID
//! - `SMOOAI_CONFIG_ENV` — Default environment name (e.g. "production")

use reqwest::Client;
use serde::Deserialize;
use std::collections::HashMap;
use std::env;

/// Client for reading configuration values from the Smoo AI config server.
pub struct ConfigClient {
    base_url: String,
    org_id: String,
    default_environment: String,
    client: Client,
    cache: HashMap<String, serde_json::Value>,
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
            client,
            cache: HashMap::new(),
        }
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

    /// Get a single config value.
    /// Pass `None` for environment to use the default.
    pub async fn get_value(
        &mut self,
        key: &str,
        environment: Option<&str>,
    ) -> Result<serde_json::Value, reqwest::Error> {
        let env = self.resolve_env(environment).to_string();
        let cache_key = format!("{}:{}", env, key);
        if let Some(value) = self.cache.get(&cache_key) {
            return Ok(value.clone());
        }

        let response: ValueResponse = self
            .client
            .get(format!(
                "{}/organizations/{}/config/values/{}",
                self.base_url, self.org_id, key
            ))
            .query(&[("environment", &env)])
            .send()
            .await?
            .json()
            .await?;

        self.cache.insert(cache_key, response.value.clone());
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

        for (key, value) in &response.values {
            self.cache.insert(format!("{}:{}", env, key), value.clone());
        }

        Ok(response.values)
    }

    /// Clear the local cache.
    pub fn invalidate_cache(&mut self) {
        self.cache.clear();
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
        client.cache.insert("prod:KEY".to_string(), serde_json::json!("value"));
        client.cache.insert("staging:KEY".to_string(), serde_json::json!(42));

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
