//! Runtime configuration client for fetching values from the Smoo AI server.
//!
//! # Authentication
//!
//! SMOODEV-975: The runtime client mints a JWT via an OAuth2
//! `client_credentials` exchange against `{auth_url}/token` before every
//! call, and caches it via [`TokenProvider`](crate::token_provider::TokenProvider).
//! Previously the SDK sent the raw API key as `Authorization: Bearer
//! <api_key>`, which the backend rejects with 401.
//!
//! # Environment Variables
//!
//! The client can be configured via environment variables when using [`ConfigClient::from_env`]:
//! - `SMOOAI_CONFIG_API_URL` — Base URL of the config API
//! - `SMOOAI_CONFIG_AUTH_URL` — OAuth issuer base URL (default
//!   `https://auth.smoo.ai`; legacy `SMOOAI_AUTH_URL` also accepted)
//! - `SMOOAI_CONFIG_CLIENT_ID` — OAuth client ID
//! - `SMOOAI_CONFIG_CLIENT_SECRET` — OAuth client secret (legacy
//!   `SMOOAI_CONFIG_API_KEY` accepted as a deprecated alias)
//! - `SMOOAI_CONFIG_ORG_ID` — Organization ID
//! - `SMOOAI_CONFIG_ENV` — Default environment name (e.g. "production")

use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use reqwest::{Client, Response};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::sync::Arc;
use std::time::{Duration, Instant};
use thiserror::Error;

use crate::token_provider::{SharedTokenProvider, TokenProvider, TokenProviderError};

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
///
/// SMOODEV-975: now uses an [`Arc<TokenProvider>`](crate::token_provider::TokenProvider)
/// to mint a JWT via OAuth2 client_credentials before each request. Pass
/// `client_id` + `client_secret` (or call [`ConfigClient::with_token_provider`])
/// on construction.
pub struct ConfigClient {
    base_url: String,
    org_id: String,
    default_environment: String,
    cache_ttl: Option<Duration>,
    client: Client,
    token_provider: SharedTokenProvider,
    cache: HashMap<String, CacheEntry>,
}

/// Unified error type for [`ConfigClient`] requests (SMOODEV-975).
///
/// Combines transport, OAuth, and decode failures so callers don't have
/// to discriminate between `reqwest::Error` and [`TokenProviderError`]
/// at the call site.
#[derive(Debug, Error)]
pub enum ConfigClientError {
    /// Underlying HTTP / JSON failure.
    #[error(transparent)]
    Request(#[from] reqwest::Error),
    /// OAuth handshake or refresh failure.
    #[error(transparent)]
    TokenProvider(#[from] TokenProviderError),
    /// Server returned a non-success status. Use
    /// [`ConfigClientError::status`] to branch on the code.
    #[error("config request failed: HTTP {status} {body}")]
    HttpStatus { status: u16, body: String },
}

impl ConfigClientError {
    /// Returns the HTTP status code when the error was an `HttpStatus`.
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::HttpStatus { status, .. } => Some(*status),
            _ => None,
        }
    }
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

/// Response from the server-side feature-flag evaluator.
///
/// Matches the wire contract defined by the TS / Python / Go clients and
/// the `/organizations/{org_id}/config/feature-flags/{key}/evaluate` endpoint.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EvaluateFeatureFlagResponse {
    /// The resolved flag value (post rules + rollout).
    pub value: serde_json::Value,
    /// Id of the rule that fired, if any.
    #[serde(rename = "matchedRuleId", skip_serializing_if = "Option::is_none")]
    pub matched_rule_id: Option<String>,
    /// 0–99 bucket the context was assigned to, if a rollout ran.
    #[serde(rename = "rolloutBucket", skip_serializing_if = "Option::is_none")]
    pub rollout_bucket: Option<u32>,
    /// Which branch the evaluator returned from: `"raw"`, `"rule"`,
    /// `"rollout"`, or `"default"`.
    pub source: String,
}

/// Errors produced by [`ConfigClient::evaluate_feature_flag`].
///
/// Mirrors the TS `FeatureFlagEvaluationError` hierarchy: callers can match
/// on `NotFound` / `ContextError` / `Evaluation` without parsing messages.
/// `Request` wraps underlying transport / deserialization failures.
#[derive(Debug, Error)]
pub enum FeatureFlagEvaluationError {
    /// Server returned 404 — the flag key is not defined in the org's schema.
    #[error("Feature flag \"{key}\" evaluation failed: HTTP 404 — flag not defined in schema")]
    NotFound { key: String },
    /// Server returned 400 — invalid context or environment.
    #[error("Feature flag \"{key}\" evaluation failed: HTTP 400 — {message}")]
    ContextError { key: String, message: String },
    /// Server returned a non-success status other than 400 / 404.
    #[error("Feature flag \"{key}\" evaluation failed: HTTP {status}{}", if .message.is_empty() { String::new() } else { format!(" — {}", .message) })]
    Evaluation { key: String, status: u16, message: String },
    /// Underlying HTTP transport or JSON deserialization failure.
    #[error("Feature flag \"{key}\" evaluation failed: {source}")]
    Request {
        key: String,
        #[source]
        source: reqwest::Error,
    },
}

impl FeatureFlagEvaluationError {
    /// The flag key the failed evaluation was for.
    pub fn key(&self) -> &str {
        match self {
            Self::NotFound { key } => key,
            Self::ContextError { key, .. } => key,
            Self::Evaluation { key, .. } => key,
            Self::Request { key, .. } => key,
        }
    }

    /// The HTTP status code, if the failure came from a server response.
    /// Returns `None` for transport / parse errors.
    pub fn status_code(&self) -> Option<u16> {
        match self {
            Self::NotFound { .. } => Some(404),
            Self::ContextError { .. } => Some(400),
            Self::Evaluation { status, .. } => Some(*status),
            Self::Request { .. } => None,
        }
    }
}

impl ConfigClient {
    /// Create a new config client with explicit parameters.
    ///
    /// SMOODEV-975: takes both `client_id` and `client_secret` to mint
    /// OAuth tokens. The OAuth issuer URL is read from the
    /// `SMOOAI_CONFIG_AUTH_URL` env var (or `SMOOAI_AUTH_URL`, or the
    /// default `https://auth.smoo.ai`). Use [`Self::with_token_provider`]
    /// for tests where you want to inject a stub provider.
    pub fn new(base_url: &str, client_id: &str, client_secret: &str, org_id: &str) -> Self {
        let default_env = env::var("SMOOAI_CONFIG_ENV").unwrap_or_else(|_| "development".to_string());
        Self::with_environment(base_url, client_id, client_secret, org_id, &default_env)
    }

    /// Create a new config client with an explicit default environment.
    pub fn with_environment(
        base_url: &str,
        client_id: &str,
        client_secret: &str,
        org_id: &str,
        environment: &str,
    ) -> Self {
        let auth_url = env::var("SMOOAI_CONFIG_AUTH_URL")
            .or_else(|_| env::var("SMOOAI_AUTH_URL"))
            .unwrap_or_else(|_| "https://auth.smoo.ai".to_string());

        let provider = TokenProvider::new(&auth_url, client_id, client_secret)
            .expect("TokenProvider construction with non-empty credentials");

        Self::with_token_provider(base_url, Arc::new(provider), org_id, environment)
    }

    /// Construct a client that uses the provided [`TokenProvider`].
    ///
    /// Useful in tests to inject a stub provider that returns a fixed
    /// JWT without performing a real OAuth handshake, and for callers
    /// that want to share a single provider across multiple clients.
    pub fn with_token_provider(
        base_url: &str,
        token_provider: SharedTokenProvider,
        org_id: &str,
        environment: &str,
    ) -> Self {
        let client = Client::builder().build().expect("reqwest client builder");

        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            org_id: org_id.to_string(),
            default_environment: environment.to_string(),
            cache_ttl: None,
            client,
            token_provider,
            cache: HashMap::new(),
        }
    }

    /// Set the cache TTL duration. `None` means cache never expires (manual invalidation only).
    pub fn set_cache_ttl(&mut self, ttl: Option<Duration>) {
        self.cache_ttl = ttl;
    }

    /// Create a config client from environment variables.
    ///
    /// SMOODEV-975: Reads `SMOOAI_CONFIG_API_URL`, `SMOOAI_CONFIG_CLIENT_ID`,
    /// `SMOOAI_CONFIG_CLIENT_SECRET` (or the legacy `SMOOAI_CONFIG_API_KEY`),
    /// `SMOOAI_CONFIG_ORG_ID`, and optionally `SMOOAI_CONFIG_ENV`
    /// (defaults to "development") and `SMOOAI_CONFIG_AUTH_URL`.
    ///
    /// # Panics
    /// Panics if any required environment variable is missing.
    pub fn from_env() -> Self {
        let base_url = env::var("SMOOAI_CONFIG_API_URL").expect("SMOOAI_CONFIG_API_URL must be set");
        let client_id = env::var("SMOOAI_CONFIG_CLIENT_ID").expect("SMOOAI_CONFIG_CLIENT_ID must be set");
        let client_secret = env::var("SMOOAI_CONFIG_CLIENT_SECRET")
            .or_else(|_| env::var("SMOOAI_CONFIG_API_KEY"))
            .expect("SMOOAI_CONFIG_CLIENT_SECRET (or legacy SMOOAI_CONFIG_API_KEY) must be set");
        let org_id = env::var("SMOOAI_CONFIG_ORG_ID").expect("SMOOAI_CONFIG_ORG_ID must be set");

        Self::new(&base_url, &client_id, &client_secret, &org_id)
    }

    /// Build an Authorization header value via the TokenProvider.
    async fn bearer_header(&self) -> Result<String, ConfigClientError> {
        let token = self.token_provider.get_access_token().await?;
        Ok(format!("Bearer {}", token))
    }

    /// Send a request with auth, retrying once after invalidating the
    /// cached token on a 401 (handles server-side rotation / revocation).
    async fn send_with_retry(
        &self,
        method: reqwest::Method,
        url: &str,
        with_body: Option<&serde_json::Value>,
        query: &[(&str, &str)],
    ) -> Result<Response, ConfigClientError> {
        // First attempt.
        let auth = self.bearer_header().await?;
        let mut req = self
            .client
            .request(method.clone(), url)
            .header(reqwest::header::AUTHORIZATION, auth)
            .query(query);
        if let Some(body) = with_body {
            req = req.header(reqwest::header::CONTENT_TYPE, "application/json").json(body);
        }
        let resp = req.send().await?;
        if resp.status().as_u16() != 401 {
            return Ok(resp);
        }
        // 401 — invalidate and retry once with a fresh token.
        self.token_provider.invalidate().await;
        let auth = self.bearer_header().await?;
        let mut req2 = self
            .client
            .request(method, url)
            .header(reqwest::header::AUTHORIZATION, auth)
            .query(query);
        if let Some(body) = with_body {
            req2 = req2
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .json(body);
        }
        Ok(req2.send().await?)
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
    ) -> Result<serde_json::Value, ConfigClientError> {
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
        let url = format!(
            "{}/organizations/{}/config/values/{}",
            self.base_url, self.org_id, encoded_key
        );

        let resp = self
            .send_with_retry(reqwest::Method::GET, &url, None, &[("environment", env.as_str())])
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(ConfigClientError::HttpStatus {
                status: status.as_u16(),
                body,
            });
        }
        let response: ValueResponse = resp.json().await?;

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
    ) -> Result<HashMap<String, serde_json::Value>, ConfigClientError> {
        let env = self.resolve_env(environment).to_string();
        let url = format!("{}/organizations/{}/config/values", self.base_url, self.org_id);

        let resp = self
            .send_with_retry(reqwest::Method::GET, &url, None, &[("environment", env.as_str())])
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(ConfigClientError::HttpStatus {
                status: status.as_u16(),
                body,
            });
        }
        let response: ValuesResponse = resp.json().await?;

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

    /// Evaluate a segment-aware feature flag on the server.
    ///
    /// Unlike [`get_value`](Self::get_value), this is always a network call —
    /// segment rules (percentage rollout, attribute matching, bucketing) live
    /// server-side and the response depends on the `context` you pass. Callers
    /// that don't need segment evaluation should keep using `get_value` for the
    /// static flag value.
    ///
    /// # Arguments
    /// * `key` — Feature-flag key. URL-encoded before being placed in the path.
    /// * `context` — Attributes the server's segment rules may reference
    ///   (e.g. `{ "userId": ..., "plan": ... }`). `None` is equivalent to an
    ///   empty map. Values must be JSON-serializable — the server hashes
    ///   `bucketBy` values by their string representation, so numbers and
    ///   booleans bucket stably across client rebuilds.
    /// * `environment` — Environment name (defaults to the client's default
    ///   environment when `None`).
    ///
    /// # Errors
    /// * [`FeatureFlagEvaluationError::NotFound`] — 404, flag not defined.
    /// * [`FeatureFlagEvaluationError::ContextError`] — 400, bad context.
    /// * [`FeatureFlagEvaluationError::Evaluation`] — other non-2xx status.
    /// * [`FeatureFlagEvaluationError::Request`] — transport / parse failure.
    pub async fn evaluate_feature_flag(
        &self,
        key: &str,
        context: Option<HashMap<String, serde_json::Value>>,
        environment: Option<&str>,
    ) -> Result<EvaluateFeatureFlagResponse, FeatureFlagEvaluationError> {
        let env = self.resolve_env(environment).to_string();
        let encoded_key = utf8_percent_encode(key, PATH_SEGMENT_ENCODE_SET).to_string();
        let url = format!(
            "{}/organizations/{}/config/feature-flags/{}/evaluate",
            self.base_url, self.org_id, encoded_key
        );

        let body = serde_json::json!({
            "environment": env,
            "context": context.unwrap_or_default(),
        });

        let response = self
            .send_with_retry(reqwest::Method::POST, &url, Some(&body), &[])
            .await
            .map_err(|err| match err {
                ConfigClientError::Request(source) => FeatureFlagEvaluationError::Request {
                    key: key.to_string(),
                    source,
                },
                // OAuth / HTTP-status errors surface as a generic evaluation
                // failure with status=0 so callers can branch on the variant
                // without losing the original message.
                other => FeatureFlagEvaluationError::Evaluation {
                    key: key.to_string(),
                    status: 0,
                    message: other.to_string(),
                },
            })?;

        let status = response.status();
        if status.is_success() {
            return response.json::<EvaluateFeatureFlagResponse>().await.map_err(|source| {
                FeatureFlagEvaluationError::Request {
                    key: key.to_string(),
                    source,
                }
            });
        }

        // Non-2xx — read body as text (best-effort) and map to typed error.
        let status_code = status.as_u16();
        let message = response.text().await.unwrap_or_default();

        Err(match status_code {
            404 => FeatureFlagEvaluationError::NotFound { key: key.to_string() },
            400 => FeatureFlagEvaluationError::ContextError {
                key: key.to_string(),
                message,
            },
            _ => FeatureFlagEvaluationError::Evaluation {
                key: key.to_string(),
                status: status_code,
                message,
            },
        })
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
        let client = ConfigClient::new("https://api.example.com/", "key", "key", "org-id");
        assert_eq!(client.base_url, "https://api.example.com");
    }

    #[test]
    fn test_new_preserves_url_without_trailing_slash() {
        let client = ConfigClient::new("https://api.example.com", "key", "key", "org-id");
        assert_eq!(client.base_url, "https://api.example.com");
    }

    #[test]
    fn test_new_stores_org_id() {
        let client = ConfigClient::new("https://api.example.com", "key", "key", "my-org-123");
        assert_eq!(client.org_id, "my-org-123");
    }

    #[test]
    fn test_new_initializes_empty_cache() {
        let client = ConfigClient::new("https://api.example.com", "key", "key", "org");
        assert!(client.cache.is_empty());
    }

    #[test]
    fn test_invalidate_cache_clears_all() {
        let mut client = ConfigClient::new("https://api.example.com", "key", "key", "org");
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
        let mut client = ConfigClient::new("https://api.example.com", "key", "key", "org");
        client.invalidate_cache();
        assert!(client.cache.is_empty());
    }

    #[test]
    fn test_invalidate_cache_for_environment() {
        let mut client = ConfigClient::new("https://api.example.com", "key", "key", "org");
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
        let client = ConfigClient::new("https://api.example.com", "key", "key", "org");
        assert!(client.cache_ttl.is_none());
    }

    #[test]
    fn test_set_cache_ttl() {
        let mut client = ConfigClient::new("https://api.example.com", "key", "key", "org");
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
        let client = ConfigClient::with_environment("https://api.example.com", "key", "key", "org", "production");
        assert_eq!(client.default_environment, "production");
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use std::time::Duration;
    use wiremock::matchers::{header, method, path_regex, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    // SMOODEV-975: stub TokenProvider helper for these in-file tests.
    // The runtime client now mints a JWT via OAuth before each call;
    // tests register a /token mock that returns a fixed token via
    // `mock_token` and then assert against `Bearer <token>` downstream.
    async fn mock_token(server: &MockServer, token: &str) {
        Mock::given(method("POST"))
            .and(path_regex(r"^/token$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": token,
                "expires_in": 3600
            })))
            .mount(server)
            .await;
    }

    /// Build a ConfigClient pointed at the mock server with a stub
    /// TokenProvider whose access_token comes from the server's /token
    /// mock. Asserts in the test should use the same token string.
    async fn test_client(server: &MockServer, token: &str, environment: &str) -> ConfigClient {
        mock_token(server, token).await;
        let tp = TokenProvider::with_options(
            &server.uri(),
            "test-client-id",
            "test-client-secret",
            Duration::from_secs(60),
            Client::new(),
        )
        .expect("valid token provider");
        ConfigClient::with_token_provider(&server.uri(), Arc::new(tp), "test-org", environment)
    }

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

        let mut client = test_client(&mock_server, "test-api-key", "production").await;
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

        let mut client = test_client(&mock_server, "test-api-key", "staging").await;
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

        let mut client = test_client(&mock_server, "my-secret-token-xyz", "production").await;
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

        let mut client = test_client(&mock_server, "test-api-key", "production").await;

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

        let mut client = test_client(&mock_server, "test-api-key", "production").await;
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

        let mut client = test_client(&mock_server, "test-api-key", "production").await;

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

        // SMOODEV-975: ConfigClient invalidates the cached token on 401
        // and retries once with a fresh JWT, so the GET fires twice.
        Mock::given(method("GET"))
            .and(path_regex(r"/organizations/.+/config/values/.+"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "error": "Unauthorized"
            })))
            .expect(2)
            .mount(&mock_server)
            .await;

        let mut client = test_client(&mock_server, "bad-api-key", "production").await;

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

        let mut client = test_client(&mock_server, "test-api-key", "production").await;

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

        let mut client = test_client(&mock_server, "test-api-key", "production").await;

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

    // -----------------------------------------------------------------------
    // evaluate_feature_flag
    // -----------------------------------------------------------------------

    use wiremock::matchers::{body_json, path as path_matcher};

    // --- Evaluate: POST with environment + context, returns parsed response ---
    #[tokio::test]
    async fn test_evaluate_feature_flag_posts_body_and_returns_response() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path_matcher(
                "/organizations/test-org/config/feature-flags/aboutPage/evaluate",
            ))
            .and(header("Authorization", "Bearer test-api-key"))
            .and(header("content-type", "application/json"))
            .and(body_json(serde_json::json!({
                "environment": "production",
                "context": { "userId": "u-1", "plan": "pro" }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "value": true,
                "source": "rule",
                "matchedRuleId": "rule-123"
            })))
            .expect(1)
            .mount(&mock_server)
            .await;

        let client = test_client(&mock_server, "test-api-key", "production").await;
        let mut ctx = HashMap::new();
        ctx.insert("userId".to_string(), serde_json::json!("u-1"));
        ctx.insert("plan".to_string(), serde_json::json!("pro"));

        let result = client
            .evaluate_feature_flag("aboutPage", Some(ctx), None)
            .await
            .expect("evaluator returns 200");

        assert_eq!(result.value, serde_json::json!(true));
        assert_eq!(result.source, "rule");
        assert_eq!(result.matched_rule_id.as_deref(), Some("rule-123"));
        assert_eq!(result.rollout_bucket, None);
    }

    // --- Evaluate: None context defaults to empty object ---
    #[tokio::test]
    async fn test_evaluate_feature_flag_defaults_context_to_empty() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path_matcher(
                "/organizations/test-org/config/feature-flags/aboutPage/evaluate",
            ))
            .and(body_json(serde_json::json!({
                "environment": "production",
                "context": {}
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "value": false,
                "source": "default"
            })))
            .expect(1)
            .mount(&mock_server)
            .await;

        let client = test_client(&mock_server, "test-api-key", "production").await;
        let result = client
            .evaluate_feature_flag("aboutPage", None, None)
            .await
            .expect("evaluator returns 200");
        assert_eq!(result.value, serde_json::json!(false));
        assert_eq!(result.source, "default");
    }

    // --- Evaluate: explicit environment override wins over default ---
    #[tokio::test]
    async fn test_evaluate_feature_flag_honors_environment_override() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path_matcher(
                "/organizations/test-org/config/feature-flags/aboutPage/evaluate",
            ))
            .and(body_json(serde_json::json!({
                "environment": "staging",
                "context": {}
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "value": true,
                "source": "raw"
            })))
            .expect(1)
            .mount(&mock_server)
            .await;

        let client = test_client(&mock_server, "test-api-key", "production").await;
        let result = client
            .evaluate_feature_flag("aboutPage", None, Some("staging"))
            .await
            .expect("evaluator returns 200");
        assert_eq!(result.source, "raw");
    }

    // --- Evaluate: flag keys with special chars are percent-encoded in path ---
    // Uses the same `PATH_SEGMENT_ENCODE_SET` as `get_value` — RFC 3986 unreserved
    // chars pass through, reserved chars (space, slash, ? etc.) are percent-encoded.
    #[tokio::test]
    async fn test_evaluate_feature_flag_url_encodes_key() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path_matcher(
                "/organizations/test-org/config/feature-flags/with%20spaces%2Fand%3Fquestion/evaluate",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "value": null,
                "source": "default"
            })))
            .expect(1)
            .mount(&mock_server)
            .await;

        let client = test_client(&mock_server, "test-api-key", "production").await;
        let result = client
            .evaluate_feature_flag("with spaces/and?question", None, None)
            .await
            .expect("evaluator returns 200");
        assert_eq!(result.value, serde_json::Value::Null);
    }

    // --- Evaluate: 404 → NotFound ---
    #[tokio::test]
    async fn test_evaluate_feature_flag_404_not_found() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path_matcher(
                "/organizations/test-org/config/feature-flags/unknown/evaluate",
            ))
            .respond_with(ResponseTemplate::new(404).set_body_string("flag not defined"))
            .expect(1)
            .mount(&mock_server)
            .await;

        let client = test_client(&mock_server, "test-api-key", "production").await;
        let err = client
            .evaluate_feature_flag("unknown", None, None)
            .await
            .expect_err("expected NotFound");

        match &err {
            FeatureFlagEvaluationError::NotFound { key } => assert_eq!(key, "unknown"),
            other => panic!("expected NotFound, got {:?}", other),
        }
        assert_eq!(err.status_code(), Some(404));
        assert_eq!(err.key(), "unknown");
    }

    // --- Evaluate: 400 → ContextError with server message ---
    #[tokio::test]
    async fn test_evaluate_feature_flag_400_context_error() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path_matcher(
                "/organizations/test-org/config/feature-flags/aboutPage/evaluate",
            ))
            .respond_with(ResponseTemplate::new(400).set_body_string("context missing required key"))
            .expect(1)
            .mount(&mock_server)
            .await;

        let client = test_client(&mock_server, "test-api-key", "production").await;
        let err = client
            .evaluate_feature_flag("aboutPage", None, None)
            .await
            .expect_err("expected ContextError");

        match &err {
            FeatureFlagEvaluationError::ContextError { key, message } => {
                assert_eq!(key, "aboutPage");
                assert_eq!(message, "context missing required key");
            }
            other => panic!("expected ContextError, got {:?}", other),
        }
        assert_eq!(err.status_code(), Some(400));
    }

    // --- Evaluate: 5xx → Evaluation ---
    #[tokio::test]
    async fn test_evaluate_feature_flag_5xx_evaluation_error() {
        let mock_server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path_matcher(
                "/organizations/test-org/config/feature-flags/aboutPage/evaluate",
            ))
            .respond_with(ResponseTemplate::new(503).set_body_string("evaluator overloaded"))
            .expect(1)
            .mount(&mock_server)
            .await;

        let client = test_client(&mock_server, "test-api-key", "production").await;
        let err = client
            .evaluate_feature_flag("aboutPage", None, None)
            .await
            .expect_err("expected Evaluation");

        match &err {
            FeatureFlagEvaluationError::Evaluation { key, status, message } => {
                assert_eq!(key, "aboutPage");
                assert_eq!(*status, 503);
                assert_eq!(message, "evaluator overloaded");
            }
            other => panic!("expected Evaluation, got {:?}", other),
        }
        assert_eq!(err.status_code(), Some(503));
    }
}

#[cfg(test)]
mod evaluate_response_tests {
    use super::*;

    #[test]
    fn test_response_deserializes_full_payload() {
        let json = r#"{"value": true, "matchedRuleId": "r-1", "rolloutBucket": 42, "source": "rollout"}"#;
        let resp: EvaluateFeatureFlagResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.value, serde_json::json!(true));
        assert_eq!(resp.matched_rule_id.as_deref(), Some("r-1"));
        assert_eq!(resp.rollout_bucket, Some(42));
        assert_eq!(resp.source, "rollout");
    }

    #[test]
    fn test_response_deserializes_minimal_payload() {
        let json = r#"{"value": "x", "source": "raw"}"#;
        let resp: EvaluateFeatureFlagResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.matched_rule_id, None);
        assert_eq!(resp.rollout_bucket, None);
    }

    #[test]
    fn test_response_serializes_with_camel_case_fields() {
        let resp = EvaluateFeatureFlagResponse {
            value: serde_json::json!(true),
            matched_rule_id: Some("r-1".to_string()),
            rollout_bucket: Some(7),
            source: "rule".to_string(),
        };
        let s = serde_json::to_string(&resp).unwrap();
        assert!(s.contains("\"matchedRuleId\":\"r-1\""));
        assert!(s.contains("\"rolloutBucket\":7"));
    }

    #[test]
    fn test_response_skips_none_optional_fields_on_serialize() {
        let resp = EvaluateFeatureFlagResponse {
            value: serde_json::json!(false),
            matched_rule_id: None,
            rollout_bucket: None,
            source: "default".to_string(),
        };
        let s = serde_json::to_string(&resp).unwrap();
        assert!(!s.contains("matchedRuleId"));
        assert!(!s.contains("rolloutBucket"));
    }

    #[test]
    fn test_error_helpers() {
        let err = FeatureFlagEvaluationError::NotFound { key: "k".into() };
        assert_eq!(err.key(), "k");
        assert_eq!(err.status_code(), Some(404));

        let err = FeatureFlagEvaluationError::ContextError {
            key: "k".into(),
            message: "bad".into(),
        };
        assert_eq!(err.status_code(), Some(400));

        let err = FeatureFlagEvaluationError::Evaluation {
            key: "k".into(),
            status: 502,
            message: "bg".into(),
        };
        assert_eq!(err.status_code(), Some(502));
    }
}
