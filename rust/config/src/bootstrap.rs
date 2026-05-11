//! Lightweight cold-start config fetcher.
//!
//! This module exists for callers that need to read a single config
//! value from a deploy script, container entry-point, or other
//! cold-start context where the full SDK is too heavy or pulls in a
//! problematic transitive dependency.
//!
//! It has **zero** imports from other modules in this crate and uses
//! only `reqwest` + `serde_json` (which are already crate deps).
//!
//! It performs a single OAuth `client_credentials` exchange, then a
//! single GET against `/organizations/{org_id}/config/values` and
//! caches the values map per-process per-env so repeated reads inside
//! the same process avoid the round-trip.
//!
//! Inputs (read from `std::env`):
//!
//! - `SMOOAI_CONFIG_API_URL` — base URL (default `https://api.smoo.ai`)
//! - `SMOOAI_CONFIG_AUTH_URL` — OAuth base URL (default `https://auth.smoo.ai`;
//!   legacy `SMOOAI_AUTH_URL` also accepted)
//! - `SMOOAI_CONFIG_CLIENT_ID` — OAuth M2M client id
//! - `SMOOAI_CONFIG_CLIENT_SECRET` — OAuth M2M client secret
//!   (legacy `SMOOAI_CONFIG_API_KEY` accepted)
//! - `SMOOAI_CONFIG_ORG_ID` — target org id
//! - `SMOOAI_CONFIG_ENV` — default env name (fallback when no SST stage)

use std::collections::HashMap;
use std::sync::Mutex;

use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use serde_json::Value;
use thiserror::Error;

/// URL-encode characters: anything not in unreserved set per RFC 3986.
/// (alphanumeric, `-`, `_`, `.`, `~` are left alone — same as JS encodeURIComponent.)
const URL_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'!')
    .add(b'"')
    .add(b'#')
    .add(b'$')
    .add(b'%')
    .add(b'&')
    .add(b'\'')
    .add(b'(')
    .add(b')')
    .add(b'*')
    .add(b'+')
    .add(b',')
    .add(b'/')
    .add(b':')
    .add(b';')
    .add(b'<')
    .add(b'=')
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

/// Errors returned by [`bootstrap_fetch`].
#[derive(Debug, Error)]
pub enum BootstrapError {
    #[error("[smooai-config/bootstrap] missing SMOOAI_CONFIG_{{CLIENT_ID,CLIENT_SECRET,ORG_ID}} in env. Set these (e.g. via `pnpm sst shell --stage <stage>`) before calling bootstrap_fetch.")]
    MissingCredentials,
    #[error("[smooai-config/bootstrap] OAuth token exchange failed: HTTP {status} {body}")]
    OAuthFailed { status: u16, body: String },
    #[error("[smooai-config/bootstrap] OAuth token endpoint returned no access_token")]
    MissingAccessToken,
    #[error("[smooai-config/bootstrap] GET /config/values failed: HTTP {status} {body}")]
    ValuesFailed { status: u16, body: String },
    #[error("[smooai-config/bootstrap] HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("[smooai-config/bootstrap] response not JSON: {0}")]
    InvalidJson(#[from] serde_json::Error),
}

#[derive(Debug, Clone)]
struct BootstrapCreds {
    api_url: String,
    auth_url: String,
    client_id: String,
    client_secret: String,
    org_id: String,
}

fn first_non_empty(values: &[Option<String>]) -> Option<String> {
    values
        .iter()
        .find_map(|v| v.as_ref().filter(|s| !s.is_empty()).cloned())
}

fn read_creds(env: &HashMap<String, String>) -> Result<BootstrapCreds, BootstrapError> {
    let api_url = env
        .get("SMOOAI_CONFIG_API_URL")
        .cloned()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://api.smoo.ai".to_string());
    let auth_url = first_non_empty(&[
        env.get("SMOOAI_CONFIG_AUTH_URL").cloned(),
        env.get("SMOOAI_AUTH_URL").cloned(),
    ])
    .unwrap_or_else(|| "https://auth.smoo.ai".to_string());
    let client_id = env.get("SMOOAI_CONFIG_CLIENT_ID").cloned().unwrap_or_default();
    let client_secret = first_non_empty(&[
        env.get("SMOOAI_CONFIG_CLIENT_SECRET").cloned(),
        env.get("SMOOAI_CONFIG_API_KEY").cloned(),
    ])
    .unwrap_or_default();
    let org_id = env.get("SMOOAI_CONFIG_ORG_ID").cloned().unwrap_or_default();

    if client_id.is_empty() || client_secret.is_empty() || org_id.is_empty() {
        return Err(BootstrapError::MissingCredentials);
    }
    Ok(BootstrapCreds {
        api_url,
        auth_url,
        client_id,
        client_secret,
        org_id,
    })
}

fn resolve_env(env: &HashMap<String, String>, explicit: Option<&str>) -> String {
    if let Some(e) = explicit {
        if !e.is_empty() {
            return e.to_string();
        }
    }
    let mut stage = env.get("SST_STAGE").cloned().filter(|s| !s.is_empty());
    if stage.is_none() {
        stage = env.get("NEXT_PUBLIC_SST_STAGE").cloned().filter(|s| !s.is_empty());
    }
    if stage.is_none() {
        if let Some(raw) = env.get("SST_RESOURCE_App").filter(|s| !s.is_empty()) {
            if let Ok(parsed) = serde_json::from_str::<Value>(raw) {
                if let Some(s) = parsed.get("stage").and_then(|v| v.as_str()) {
                    if !s.is_empty() {
                        stage = Some(s.to_string());
                    }
                }
            }
        }
    }
    match stage {
        Some(s) if s == "production" => "production".to_string(),
        Some(s) => s,
        None => env
            .get("SMOOAI_CONFIG_ENV")
            .cloned()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "development".to_string()),
    }
}

/// In-process cache of fetched values, keyed by env name.
static CACHE: Mutex<Option<(String, HashMap<String, Value>)>> = Mutex::new(None);

/// Test-only: clear the in-process cache.
#[doc(hidden)]
pub fn __reset_bootstrap_cache() {
    let mut guard = CACHE.lock().unwrap();
    *guard = None;
}

fn env_map() -> HashMap<String, String> {
    std::env::vars().collect()
}

/// Fetch a single config value by camelCase key.
///
/// Returns `Ok(None)` if the key is not present in the values map. Only
/// env, auth, and network failures produce errors.
///
/// The full values map is cached per-process per-env after the first
/// call.
pub async fn bootstrap_fetch(key: &str, environment: Option<&str>) -> Result<Option<String>, BootstrapError> {
    bootstrap_fetch_with_env(key, environment, &env_map(), &reqwest::Client::new()).await
}

/// Same as [`bootstrap_fetch`] but with an explicit env map and client.
/// Useful for tests; not part of the stable public API.
#[doc(hidden)]
pub async fn bootstrap_fetch_with_env(
    key: &str,
    environment: Option<&str>,
    env: &HashMap<String, String>,
    client: &reqwest::Client,
) -> Result<Option<String>, BootstrapError> {
    let env_name = resolve_env(env, environment);

    let need_fetch = {
        let guard = CACHE.lock().unwrap();
        match guard.as_ref() {
            Some((cached_env, _)) => cached_env != &env_name,
            None => true,
        }
    };

    if need_fetch {
        let creds = read_creds(env)?;
        let token = mint_access_token(client, &creds).await?;
        let values = fetch_values(client, &creds, &token, &env_name).await?;
        let mut guard = CACHE.lock().unwrap();
        *guard = Some((env_name.clone(), values));
    }

    let guard = CACHE.lock().unwrap();
    let values = &guard.as_ref().expect("cache populated above").1;
    Ok(values.get(key).and_then(value_to_string))
}

fn value_to_string(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(if *b { "true".to_string() } else { "false".to_string() }),
        Value::Number(n) => Some(n.to_string()),
        other => Some(other.to_string()),
    }
}

async fn mint_access_token(client: &reqwest::Client, creds: &BootstrapCreds) -> Result<String, BootstrapError> {
    let auth_base = creds.auth_url.trim_end_matches('/');
    let url = format!("{}/token", auth_base);
    let form = [
        ("grant_type", "client_credentials"),
        ("provider", "client_credentials"),
        ("client_id", creds.client_id.as_str()),
        ("client_secret", creds.client_secret.as_str()),
    ];

    let resp = client.post(&url).form(&form).send().await?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(BootstrapError::OAuthFailed {
            status: status.as_u16(),
            body,
        });
    }
    let parsed: Value = serde_json::from_str(&body)?;
    let token = parsed
        .get("access_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    token
        .filter(|t| !t.is_empty())
        .ok_or(BootstrapError::MissingAccessToken)
}

async fn fetch_values(
    client: &reqwest::Client,
    creds: &BootstrapCreds,
    token: &str,
    env: &str,
) -> Result<HashMap<String, Value>, BootstrapError> {
    let api_base = creds.api_url.trim_end_matches('/');
    let org = utf8_percent_encode(&creds.org_id, URL_ENCODE_SET).to_string();
    let env_enc = utf8_percent_encode(env, URL_ENCODE_SET).to_string();
    let url = format!(
        "{}/organizations/{}/config/values?environment={}",
        api_base, org, env_enc
    );
    let resp = client
        .get(&url)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .send()
        .await?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(BootstrapError::ValuesFailed {
            status: status.as_u16(),
            body,
        });
    }
    let parsed: Value = serde_json::from_str(&body)?;
    let values = parsed
        .get("values")
        .and_then(|v| v.as_object())
        .map(|m| {
            m.iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect::<HashMap<String, Value>>()
        })
        .unwrap_or_default();
    Ok(values)
}

#[cfg(test)]
#[allow(clippy::await_holding_lock)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex as StdMutex;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    // All bootstrap_fetch_with_env tests share the process-wide CACHE,
    // so we serialize them with a dedicated mutex.
    static TEST_LOCK: StdMutex<()> = StdMutex::new(());

    fn lock_and_reset() -> std::sync::MutexGuard<'static, ()> {
        // Recover from any prior poisoned panic so a single failing
        // test doesn't break the rest of the suite.
        let g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        super::__reset_bootstrap_cache();
        g
    }

    fn base_env(server_url: &str) -> HashMap<String, String> {
        let mut m = HashMap::new();
        m.insert("SMOOAI_CONFIG_API_URL".into(), server_url.into());
        m.insert("SMOOAI_CONFIG_AUTH_URL".into(), server_url.into());
        m.insert("SMOOAI_CONFIG_CLIENT_ID".into(), "client-id-123".into());
        m.insert("SMOOAI_CONFIG_CLIENT_SECRET".into(), "client-secret-456".into());
        m.insert("SMOOAI_CONFIG_ORG_ID".into(), "org-789".into());
        m
    }

    async fn mount_oauth_ok(server: &MockServer, token: &str) {
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"access_token": token})))
            .mount(server)
            .await;
    }

    async fn mount_values(server: &MockServer, env: &str, values: serde_json::Value) {
        Mock::given(method("GET"))
            .and(path("/organizations/org-789/config/values"))
            .and(query_param("environment", env))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"values": values})))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn returns_value_for_known_key() {
        let _g = lock_and_reset();
        let server = MockServer::start().await;
        mount_oauth_ok(&server, "TOKEN").await;
        mount_values(&server, "development", json!({"databaseUrl": "postgres://x"})).await;
        let env = base_env(&server.uri());
        let v = bootstrap_fetch_with_env("databaseUrl", None, &env, &reqwest::Client::new())
            .await
            .unwrap();
        assert_eq!(v, Some("postgres://x".to_string()));
    }

    #[tokio::test]
    async fn returns_none_for_missing_key() {
        let _g = lock_and_reset();
        let server = MockServer::start().await;
        mount_oauth_ok(&server, "T").await;
        mount_values(&server, "development", json!({"other": "x"})).await;
        let env = base_env(&server.uri());
        let v = bootstrap_fetch_with_env("databaseUrl", None, &env, &reqwest::Client::new())
            .await
            .unwrap();
        assert_eq!(v, None);
    }

    #[tokio::test]
    async fn caches_values_per_env() {
        let _g = lock_and_reset();
        let server = MockServer::start().await;
        // Each mount with `expect(1)` would fail if called more than once.
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"access_token": "T"})))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/organizations/org-789/config/values"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"values": {"a": "1", "b": "2"}})))
            .expect(1)
            .mount(&server)
            .await;
        let env = base_env(&server.uri());
        let c = reqwest::Client::new();
        assert_eq!(
            bootstrap_fetch_with_env("a", None, &env, &c).await.unwrap(),
            Some("1".into())
        );
        assert_eq!(
            bootstrap_fetch_with_env("b", None, &env, &c).await.unwrap(),
            Some("2".into())
        );
    }

    #[tokio::test]
    async fn refetches_on_env_change() {
        let _g = lock_and_reset();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"access_token": "T"})))
            .expect(2)
            .mount(&server)
            .await;
        mount_values(&server, "development", json!({"a": "dev"})).await;
        mount_values(&server, "production", json!({"a": "prod"})).await;
        let env = base_env(&server.uri());
        let c = reqwest::Client::new();
        assert_eq!(
            bootstrap_fetch_with_env("a", Some("development"), &env, &c)
                .await
                .unwrap(),
            Some("dev".into())
        );
        assert_eq!(
            bootstrap_fetch_with_env("a", Some("production"), &env, &c)
                .await
                .unwrap(),
            Some("prod".into())
        );
    }

    #[tokio::test]
    async fn missing_creds_errors() {
        let _g = lock_and_reset();
        let mut env = base_env("http://example.test");
        env.remove("SMOOAI_CONFIG_CLIENT_ID");
        let err = bootstrap_fetch_with_env("k", None, &env, &reqwest::Client::new())
            .await
            .unwrap_err();
        matches!(err, BootstrapError::MissingCredentials);
    }

    #[tokio::test]
    async fn accepts_legacy_api_key() {
        let _g = lock_and_reset();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .and(wiremock::matchers::body_string_contains("client_secret=legacy-secret"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"access_token": "T"})))
            .expect(1)
            .mount(&server)
            .await;
        mount_values(&server, "development", json!({"k": "v"})).await;
        let mut env = base_env(&server.uri());
        env.remove("SMOOAI_CONFIG_CLIENT_SECRET");
        env.insert("SMOOAI_CONFIG_API_KEY".into(), "legacy-secret".into());
        let v = bootstrap_fetch_with_env("k", None, &env, &reqwest::Client::new())
            .await
            .unwrap();
        assert_eq!(v, Some("v".into()));
    }

    #[tokio::test]
    async fn oauth_failure_returns_error() {
        let _g = lock_and_reset();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(401).set_body_string("invalid_client"))
            .mount(&server)
            .await;
        let env = base_env(&server.uri());
        let err = bootstrap_fetch_with_env("k", None, &env, &reqwest::Client::new())
            .await
            .unwrap_err();
        match err {
            BootstrapError::OAuthFailed { status, .. } => assert_eq!(status, 401),
            _ => panic!("expected OAuthFailed, got {:?}", err),
        }
    }

    #[tokio::test]
    async fn values_failure_returns_error() {
        let _g = lock_and_reset();
        let server = MockServer::start().await;
        mount_oauth_ok(&server, "T").await;
        Mock::given(method("GET"))
            .and(path("/organizations/org-789/config/values"))
            .respond_with(ResponseTemplate::new(500).set_body_string("boom"))
            .mount(&server)
            .await;
        let env = base_env(&server.uri());
        let err = bootstrap_fetch_with_env("k", None, &env, &reqwest::Client::new())
            .await
            .unwrap_err();
        match err {
            BootstrapError::ValuesFailed { status, .. } => assert_eq!(status, 500),
            _ => panic!("expected ValuesFailed, got {:?}", err),
        }
    }

    #[tokio::test]
    async fn oauth_missing_access_token_errors() {
        let _g = lock_and_reset();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .mount(&server)
            .await;
        let env = base_env(&server.uri());
        let err = bootstrap_fetch_with_env("k", None, &env, &reqwest::Client::new())
            .await
            .unwrap_err();
        matches!(err, BootstrapError::MissingAccessToken);
    }

    #[test]
    fn resolve_env_explicit_wins() {
        let mut env = HashMap::new();
        env.insert("SST_STAGE".into(), "ignored".into());
        assert_eq!(resolve_env(&env, Some("explicit")), "explicit");
    }

    #[test]
    fn resolve_env_sst_stage() {
        let mut env = HashMap::new();
        env.insert("SST_STAGE".into(), "brentrager".into());
        assert_eq!(resolve_env(&env, None), "brentrager");
    }

    #[test]
    fn resolve_env_next_public_stage() {
        let mut env = HashMap::new();
        env.insert("NEXT_PUBLIC_SST_STAGE".into(), "dev-stage".into());
        assert_eq!(resolve_env(&env, None), "dev-stage");
    }

    #[test]
    fn resolve_env_sst_resource_app() {
        let mut env = HashMap::new();
        env.insert("SST_RESOURCE_App".into(), r#"{"stage":"sst-resource-stage"}"#.into());
        assert_eq!(resolve_env(&env, None), "sst-resource-stage");
    }

    #[test]
    fn resolve_env_production() {
        let mut env = HashMap::new();
        env.insert("SST_STAGE".into(), "production".into());
        assert_eq!(resolve_env(&env, None), "production");
    }

    #[test]
    fn resolve_env_smooai_env_fallback() {
        let mut env = HashMap::new();
        env.insert("SMOOAI_CONFIG_ENV".into(), "qa".into());
        assert_eq!(resolve_env(&env, None), "qa");
    }

    #[test]
    fn resolve_env_development_default() {
        let env = HashMap::new();
        assert_eq!(resolve_env(&env, None), "development");
    }

    #[test]
    fn resolve_env_malformed_sst_resource_app_falls_through() {
        let mut env = HashMap::new();
        env.insert("SST_RESOURCE_App".into(), "{not json".into());
        env.insert("SMOOAI_CONFIG_ENV".into(), "qa".into());
        assert_eq!(resolve_env(&env, None), "qa");
    }

    #[tokio::test]
    async fn stringifies_non_string_values() {
        let _g = lock_and_reset();
        let server = MockServer::start().await;
        mount_oauth_ok(&server, "T").await;
        mount_values(&server, "development", json!({"count": 42, "flag": true, "pi": 3.5})).await;
        let env = base_env(&server.uri());
        let c = reqwest::Client::new();
        assert_eq!(
            bootstrap_fetch_with_env("count", None, &env, &c).await.unwrap(),
            Some("42".into())
        );
        assert_eq!(
            bootstrap_fetch_with_env("flag", None, &env, &c).await.unwrap(),
            Some("true".into())
        );
        assert_eq!(
            bootstrap_fetch_with_env("pi", None, &env, &c).await.unwrap(),
            Some("3.5".into())
        );
    }
}
