//! OAuth2 `client_credentials` token provider for the runtime [`ConfigClient`].
//!
//! Parity with `src/platform/TokenProvider.ts` (SMOODEV-974),
//! `python/src/smooai_config/token_provider.py`, and
//! `go/config/token_provider.go`. Extracted from `ConfigClient` so the
//! same logic can be shared, mocked in tests, and reused by other
//! in-package callers.
//!
//! # Server contract
//!
//! ```text
//! POST {auth_url}/token
//! Content-Type: application/x-www-form-urlencoded
//!
//! grant_type=client_credentials
//! provider=client_credentials
//! client_id=<uuid>
//! client_secret=sk_...
//! ```
//!
//! SMOODEV-975: replaces the previous `Authorization: Bearer <api_key>`
//! shortcut that the backend rejects with 401 because it expects a JWT.

use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::Client;
use serde::Deserialize;
use thiserror::Error;
use tokio::sync::Mutex;

/// Errors raised by [`TokenProvider`].
#[derive(Debug, Error)]
pub enum TokenProviderError {
    /// The OAuth issuer returned a non-2xx status code.
    #[error("@smooai/config: OAuth token exchange failed: HTTP {status} {body}")]
    OAuthFailed { status: u16, body: String },
    /// The OAuth issuer returned a 2xx but the body lacked an `access_token`.
    #[error("@smooai/config: OAuth token endpoint returned no access_token")]
    MissingAccessToken,
    /// HTTP transport failure (DNS, connect, TLS, etc.).
    #[error("@smooai/config: OAuth request failed: {0}")]
    Request(#[from] reqwest::Error),
    /// The response body wasn't valid JSON.
    #[error("@smooai/config: OAuth response not JSON: {0}")]
    BadJson(#[from] serde_json::Error),
    /// Constructor was called with an empty required argument.
    #[error("@smooai/config: {0}")]
    InvalidArgument(String),
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    expires_in: Option<i64>,
}

#[derive(Debug, Clone)]
struct CachedToken {
    access_token: String,
    expires_at: Instant,
}

/// OAuth2 `client_credentials` token provider.
///
/// Exchanges `(client_id, client_secret)` for an access token at
/// `{auth_url}/token` and caches the JWT in memory until it's within
/// `refresh_window` of expiry. Thread-safe and async-safe; concurrent
/// callers serialize through a `tokio::sync::Mutex` and share a single
/// refreshed token rather than issuing parallel exchanges.
///
/// `TokenProvider` is meant to be wrapped in an [`Arc`] and shared
/// across the [`ConfigClient`] and any other callers that need to mint
/// the same JWT.
#[derive(Debug)]
pub struct TokenProvider {
    auth_url: String,
    client_id: String,
    client_secret: String,
    refresh_window: Duration,
    http_client: Client,
    cache: Mutex<Option<CachedToken>>,
}

impl TokenProvider {
    /// Construct a provider. Default `refresh_window` is 60s (matches the
    /// .NET / TypeScript defaults).
    ///
    /// Returns [`TokenProviderError::InvalidArgument`] when any of the
    /// three required string fields is empty.
    pub fn new(auth_url: &str, client_id: &str, client_secret: &str) -> Result<Self, TokenProviderError> {
        Self::with_options(
            auth_url,
            client_id,
            client_secret,
            Duration::from_secs(60),
            Client::new(),
        )
    }

    /// Construct a provider with a custom refresh window and HTTP client.
    /// The HTTP client is useful in tests so callers can route the token
    /// exchange through a wiremock instance.
    pub fn with_options(
        auth_url: &str,
        client_id: &str,
        client_secret: &str,
        refresh_window: Duration,
        http_client: Client,
    ) -> Result<Self, TokenProviderError> {
        if auth_url.is_empty() {
            return Err(TokenProviderError::InvalidArgument(
                "TokenProvider requires auth_url".to_string(),
            ));
        }
        if client_id.is_empty() {
            return Err(TokenProviderError::InvalidArgument(
                "TokenProvider requires client_id".to_string(),
            ));
        }
        if client_secret.is_empty() {
            return Err(TokenProviderError::InvalidArgument(
                "TokenProvider requires client_secret".to_string(),
            ));
        }
        Ok(Self {
            auth_url: auth_url.trim_end_matches('/').to_string(),
            client_id: client_id.to_string(),
            client_secret: client_secret.to_string(),
            refresh_window,
            http_client,
            cache: Mutex::new(None),
        })
    }

    /// Return a valid OAuth access token, refreshing from the issuer if
    /// the cache is missing or within the refresh window of expiry.
    pub async fn get_access_token(&self) -> Result<String, TokenProviderError> {
        let mut guard = self.cache.lock().await;
        if let Some(cached) = guard.as_ref() {
            if Instant::now()
                < cached
                    .expires_at
                    .checked_sub(self.refresh_window)
                    .unwrap_or(cached.expires_at)
            {
                return Ok(cached.access_token.clone());
            }
        }
        // Cache miss or stale — exchange under the lock so concurrent
        // callers share the single refreshed token.
        let token = self.refresh().await?;
        *guard = Some(token.clone());
        Ok(token.access_token)
    }

    /// Invalidate the cached token so the next [`get_access_token`](Self::get_access_token)
    /// call re-exchanges. Used by callers that observe a 401 from a
    /// downstream request and want to retry once with a fresh token.
    pub async fn invalidate(&self) {
        *self.cache.lock().await = None;
    }

    async fn refresh(&self) -> Result<CachedToken, TokenProviderError> {
        let url = format!("{}/token", self.auth_url);
        let form = [
            ("grant_type", "client_credentials"),
            ("provider", "client_credentials"),
            ("client_id", self.client_id.as_str()),
            ("client_secret", self.client_secret.as_str()),
        ];
        let resp = self.http_client.post(&url).form(&form).send().await?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(TokenProviderError::OAuthFailed {
                status: status.as_u16(),
                body,
            });
        }
        let parsed: TokenResponse = serde_json::from_str(&body)?;
        let access_token = parsed
            .access_token
            .filter(|t| !t.is_empty())
            .ok_or(TokenProviderError::MissingAccessToken)?;
        let expires_in_secs = parsed.expires_in.filter(|n| *n > 0).unwrap_or(3600) as u64;
        Ok(CachedToken {
            access_token,
            expires_at: Instant::now() + Duration::from_secs(expires_in_secs),
        })
    }
}

/// Type alias for the shared `Arc<TokenProvider>` callers pass to the
/// [`ConfigClient`].
pub type SharedTokenProvider = Arc<TokenProvider>;
