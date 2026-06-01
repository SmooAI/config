//! Integration tests for container / runtime mode (SMOODEV-1494).
//!
//! Parity with the TS reference suite `src/container/__tests__/container.test.ts`:
//! bootstrap-missing-env errs and lists the missing vars; required-key
//! unresolved errs (not absent); optional-key absent is `Ok(None)`; happy-path
//! fetch+cache; 401 → refresh → retry; health healthy/unhealthy; and
//! `select_mode` (§2).
//!
//! Env-touching tests serialize through `ENV_LOCK` and snapshot/restore the
//! `SMOOAI_*` / `SMOO_CONFIG*` / schema-key env so a host shell can't leak in
//! and parallel tests don't race the global process environment.

use std::env;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use reqwest::Client;
use serde_json::json;
use smooai_config::container::{
    config_health, init_container_config, select_mode, ConfigError, ConfigHealth, ContainerConfigHandle,
    InitContainerConfigOptions, Mode, SelectModeInputs, __reset_select_mode_log_for_tests,
};
use smooai_config::{ConfigClient, TokenProvider};
use wiremock::matchers::{header, method, path_regex, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Env var names that container-mode resolution reads. Snapshotted + cleared
/// around env-touching tests so the host shell can't leak into them.
const TOUCHED_ENV: &[&str] = &[
    "SMOOAI_CONFIG_MODE",
    "SMOOAI_CONFIG_API_URL",
    "SMOOAI_CONFIG_AUTH_URL",
    "SMOOAI_AUTH_URL",
    "SMOOAI_CONFIG_CLIENT_ID",
    "SMOOAI_CONFIG_CLIENT_SECRET",
    "SMOOAI_CONFIG_API_KEY",
    "SMOOAI_CONFIG_ORG_ID",
    "SMOOAI_CONFIG_ENV",
    "SMOO_CONFIG_KEY",
    "SMOO_CONFIG_KEY_FILE",
    // schema-key env names the env tier would read
    "STRIPE_API_KEY",
    "SENDGRID_API_KEY",
    "API_BASE_URL",
    "NEW_CHECKOUT",
];

struct EnvGuard {
    saved: Vec<(&'static str, Option<String>)>,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl EnvGuard {
    /// Acquire the env lock, snapshot + clear all touched env vars.
    fn acquire() -> Self {
        let lock = env_lock().lock().unwrap_or_else(|p| p.into_inner());
        let mut saved = Vec::new();
        for &k in TOUCHED_ENV {
            saved.push((k, env::var(k).ok()));
            // SAFETY: serialized through ENV_LOCK; restored on drop.
            unsafe { env::remove_var(k) };
        }
        EnvGuard { saved, _lock: lock }
    }

    fn set(&self, key: &str, value: &str) {
        // SAFETY: serialized through ENV_LOCK.
        unsafe { env::set_var(key, value) };
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (k, v) in &self.saved {
            // SAFETY: serialized through ENV_LOCK.
            unsafe {
                match v {
                    Some(val) => env::set_var(k, val),
                    None => env::remove_var(k),
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

async fn mock_token(server: &MockServer, token: &str) {
    Mock::given(method("POST"))
        .and(path_regex(r"^/token$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": token,
            "expires_in": 3600
        })))
        .mount(server)
        .await;
}

/// Build a ConfigClient pointed at the mock server with a real TokenProvider
/// whose token comes from the server's /token mock.
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

fn opts_with_client(client: ConfigClient) -> InitContainerConfigOptions {
    InitContainerConfigOptions {
        environment: Some("production".to_string()),
        config_client: Some(client),
        ..Default::default()
    }
}

async fn handle_with_initial(server: &MockServer, values: serde_json::Value) -> ContainerConfigHandle {
    Mock::given(method("GET"))
        .and(path_regex(r"/organizations/.+/config/values$"))
        .and(query_param("environment", "production"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "values": values })))
        .mount(server)
        .await;
    let client = test_client(server, "test-token", "production").await;
    init_container_config(opts_with_client(client)).await.expect("init ok")
}

// ---------------------------------------------------------------------------
// Bootstrap validation (§3)
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn bootstrap_lists_every_missing_required_env() {
    let _guard = EnvGuard::acquire();
    // No env set, no injected client.
    let err = init_container_config(InitContainerConfigOptions::default())
        .await
        .expect_err("should fail");
    match err {
        ConfigError::Bootstrap(b) => {
            for expected in [
                "SMOOAI_CONFIG_API_URL",
                "SMOOAI_CONFIG_CLIENT_ID",
                "SMOOAI_CONFIG_CLIENT_SECRET",
                "SMOOAI_CONFIG_ORG_ID",
                "SMOOAI_CONFIG_ENV",
            ] {
                assert!(
                    b.missing.iter().any(|m| m == expected),
                    "missing should contain {expected}: {:?}",
                    b.missing
                );
            }
            assert!(b.to_string().contains("SMOOAI_CONFIG_API_URL"));
        }
        other => panic!("expected Bootstrap, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn bootstrap_lists_only_actually_missing_vars() {
    let guard = EnvGuard::acquire();
    guard.set("SMOOAI_CONFIG_API_URL", "https://api.smooai.test");
    guard.set("SMOOAI_CONFIG_CLIENT_ID", "id");
    guard.set("SMOOAI_CONFIG_ORG_ID", "org-1");
    guard.set("SMOOAI_CONFIG_ENV", "production");
    // CLIENT_SECRET missing.
    let err = init_container_config(InitContainerConfigOptions::default())
        .await
        .expect_err("should fail");
    match err {
        ConfigError::Bootstrap(b) => assert_eq!(b.missing, vec!["SMOOAI_CONFIG_CLIENT_SECRET"]),
        other => panic!("expected Bootstrap, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn bootstrap_treats_blank_env_as_missing() {
    let guard = EnvGuard::acquire();
    guard.set("SMOOAI_CONFIG_API_URL", "https://api.smooai.test");
    guard.set("SMOOAI_CONFIG_CLIENT_ID", "   ");
    guard.set("SMOOAI_CONFIG_CLIENT_SECRET", "secret");
    guard.set("SMOOAI_CONFIG_ORG_ID", "org-1");
    guard.set("SMOOAI_CONFIG_ENV", "production");
    let err = init_container_config(InitContainerConfigOptions::default())
        .await
        .expect_err("should fail");
    match err {
        ConfigError::Bootstrap(b) => assert_eq!(b.missing, vec!["SMOOAI_CONFIG_CLIENT_ID"]),
        other => panic!("expected Bootstrap, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn bootstrap_accepts_legacy_api_key_as_secret() {
    let guard = EnvGuard::acquire();
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path_regex(r"/organizations/.+/config/values$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "values": {} })))
        .mount(&server)
        .await;
    mock_token(&server, "T").await;

    guard.set("SMOOAI_CONFIG_API_URL", &server.uri());
    guard.set("SMOOAI_CONFIG_AUTH_URL", &server.uri());
    guard.set("SMOOAI_CONFIG_CLIENT_ID", "id");
    guard.set("SMOOAI_CONFIG_API_KEY", "legacy-secret"); // legacy alias for the secret
    guard.set("SMOOAI_CONFIG_ORG_ID", "org-1");
    guard.set("SMOOAI_CONFIG_ENV", "production");

    let handle = init_container_config(InitContainerConfigOptions::default())
        .await
        .expect("init ok with legacy key");
    assert!(handle.health().is_healthy());
}

#[tokio::test(flavor = "multi_thread")]
async fn bootstrap_with_injected_client_only_env_required() {
    let _guard = EnvGuard::acquire();
    let server = MockServer::start().await;
    let client = test_client(&server, "T", "production").await;
    // environment omitted from options, none in env -> only SMOOAI_CONFIG_ENV missing.
    let err = init_container_config(InitContainerConfigOptions {
        config_client: Some(client),
        ..Default::default()
    })
    .await
    .expect_err("should fail");
    match err {
        ConfigError::Bootstrap(b) => assert_eq!(b.missing, vec!["SMOOAI_CONFIG_ENV"]),
        other => panic!("expected Bootstrap, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Startup fetch (fail at boot, not first read)
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn startup_fetch_failure_fails_init() {
    let _guard = EnvGuard::acquire();
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path_regex(r"/organizations/.+/config/values$"))
        .respond_with(ResponseTemplate::new(500).set_body_string("boom"))
        .mount(&server)
        .await;
    let client = test_client(&server, "T", "production").await;
    let err = init_container_config(opts_with_client(client))
        .await
        .expect_err("init should fail");
    match err {
        ConfigError::Fetch(msg) => assert!(msg.contains("500"), "expected 500 in message, got {msg}"),
        other => panic!("expected Fetch, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn happy_path_initial_fetch_seeds_cache_no_second_call() {
    let _guard = EnvGuard::acquire();
    let server = MockServer::start().await;
    // getAllValues is the only allowed call; per-key GET is NOT mounted, so a
    // second HTTP call would 404 and the assertions below would fail.
    let handle = handle_with_initial(
        &server,
        json!({ "stripeApiKey": "sk_live_123", "apiBaseUrl": "https://x" }),
    )
    .await;

    assert_eq!(
        handle.secret_config().get("stripeApiKey").await.unwrap(),
        Some(json!("sk_live_123"))
    );
    assert_eq!(
        handle.public_config().get("apiBaseUrl").await.unwrap(),
        Some(json!("https://x"))
    );
}

// ---------------------------------------------------------------------------
// Fail-loud reads (§3)
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn required_secret_unresolved_errors() {
    let _guard = EnvGuard::acquire();
    let server = MockServer::start().await;
    // initial getAllValues empty, then per-key getValue returns null.
    Mock::given(method("GET"))
        .and(path_regex(r"/organizations/.+/config/values$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "values": {} })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"/organizations/.+/config/values/.+"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "value": null })))
        .mount(&server)
        .await;
    let client = test_client(&server, "T", "production").await;
    let handle = init_container_config(opts_with_client(client)).await.unwrap();

    let err = handle
        .secret_config()
        .get("stripeApiKey")
        .await
        .expect_err("should be unresolved");
    match err {
        ConfigError::KeyUnresolved(e) => {
            assert_eq!(e.key, "stripeApiKey");
            assert_eq!(e.env, "production");
            assert_eq!(
                e.tried_tiers.iter().map(|t| t.as_str()).collect::<Vec<_>>(),
                vec!["env", "http"]
            );
        }
        other => panic!("expected KeyUnresolved, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn optional_key_absent_returns_none() {
    let _guard = EnvGuard::acquire();
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path_regex(r"/organizations/.+/config/values$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "values": {} })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"/organizations/.+/config/values/.+"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "value": null })))
        .mount(&server)
        .await;
    let client = test_client(&server, "T", "production").await;
    let handle = init_container_config(InitContainerConfigOptions {
        environment: Some("production".to_string()),
        config_client: Some(client),
        optional_keys: vec!["sendgridApiKey".to_string()],
        ..Default::default()
    })
    .await
    .unwrap();

    assert_eq!(handle.secret_config().get("sendgridApiKey").await.unwrap(), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn get_sync_unresolved_required_errors() {
    let _guard = EnvGuard::acquire();
    let server = MockServer::start().await;
    let handle = handle_with_initial(&server, json!({})).await;
    let err = handle
        .secret_config()
        .get_sync("stripeApiKey")
        .expect_err("should be unresolved");
    assert!(matches!(err, ConfigError::KeyUnresolved(_)));
}

#[tokio::test(flavor = "multi_thread")]
async fn get_sync_returns_cached_value() {
    let _guard = EnvGuard::acquire();
    let server = MockServer::start().await;
    let handle = handle_with_initial(&server, json!({ "stripeApiKey": "sk_cached" })).await;
    assert_eq!(
        handle.secret_config().get_sync("stripeApiKey").unwrap(),
        Some(json!("sk_cached"))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn env_override_wins_over_http() {
    let guard = EnvGuard::acquire();
    let server = MockServer::start().await;
    let handle = handle_with_initial(&server, json!({ "stripeApiKey": "sk_from_http" })).await;
    guard.set("STRIPE_API_KEY", "sk_from_env");
    assert_eq!(
        handle.secret_config().get("stripeApiKey").await.unwrap(),
        Some(json!("sk_from_env"))
    );
    // sync read sees it too.
    assert_eq!(
        handle.secret_config().get_sync("stripeApiKey").unwrap(),
        Some(json!("sk_from_env"))
    );
}

// ---------------------------------------------------------------------------
// 401 -> refresh -> retry (§5)
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn unauthorized_triggers_token_refresh_and_retry() {
    let _guard = EnvGuard::acquire();
    let server = MockServer::start().await;

    // initial getAllValues ok (empty).
    Mock::given(method("GET"))
        .and(path_regex(r"/organizations/.+/config/values$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "values": {} })))
        .mount(&server)
        .await;
    // Token endpoint: first mint -> "stale" (the value endpoint will 401 it),
    // second mint (after invalidate) -> "fresh". Ordered via up_to_n_times.
    Mock::given(method("POST"))
        .and(path_regex(r"^/token$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "access_token": "stale", "expires_in": 3600 })))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path_regex(r"^/token$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "access_token": "fresh", "expires_in": 3600 })))
        .mount(&server)
        .await;
    // Value endpoint: 401 for the stale bearer (triggers invalidate + retry),
    // 200 for the fresh one.
    Mock::given(method("GET"))
        .and(path_regex(r"/organizations/.+/config/values/.+"))
        .and(header("Authorization", "Bearer stale"))
        .respond_with(ResponseTemplate::new(401).set_body_string("expired"))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"/organizations/.+/config/values/.+"))
        .and(header("Authorization", "Bearer fresh"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "value": "sk_after_refresh" })))
        .mount(&server)
        .await;

    let tp =
        TokenProvider::with_options(&server.uri(), "id", "secret", Duration::from_secs(60), Client::new()).unwrap();
    let client = ConfigClient::with_token_provider(&server.uri(), Arc::new(tp), "test-org", "production");
    let handle = init_container_config(opts_with_client(client)).await.unwrap();

    // The retry (after a 401 invalidates the stale token) is what makes this
    // resolve to a value rather than error.
    let v = handle.secret_config().get("stripeApiKey").await.unwrap();
    assert_eq!(v, Some(json!("sk_after_refresh")));
}

// ---------------------------------------------------------------------------
// Health (§4 / §5)
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn health_reports_healthy_after_successful_fetch() {
    let _guard = EnvGuard::acquire();
    let server = MockServer::start().await;
    let handle = handle_with_initial(&server, json!({ "stripeApiKey": "sk" })).await;
    assert_eq!(handle.health(), ConfigHealth::Healthy);
    assert_eq!(config_health(&handle), ConfigHealth::Healthy);
}

#[tokio::test(flavor = "multi_thread")]
async fn health_unhealthy_when_refresh_fails_past_ttl() {
    let _guard = EnvGuard::acquire();
    let server = MockServer::start().await;
    // initial getAllValues seeds stripeApiKey; per-key getValue fails (503).
    Mock::given(method("GET"))
        .and(path_regex(r"/organizations/.+/config/values$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "values": { "stripeApiKey": "sk_initial" } })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"/organizations/.+/config/values/.+"))
        .respond_with(ResponseTemplate::new(503).set_body_string("network down"))
        .mount(&server)
        .await;
    let client = test_client(&server, "T", "production").await;
    let handle = init_container_config(InitContainerConfigOptions {
        environment: Some("production".to_string()),
        config_client: Some(client),
        // Tiny TTL so the seeded value + health window expire fast.
        cache_ttl: Some(Duration::from_millis(10)),
        ..Default::default()
    })
    .await
    .unwrap();

    assert!(handle.health().is_healthy());

    // Let the per-key cache + the seeded last-good expire.
    tokio::time::sleep(Duration::from_millis(40)).await;

    // last-good gone (TTL expired) AND http failed -> unresolved required.
    let err = handle
        .secret_config()
        .get("stripeApiKey")
        .await
        .expect_err("should be unresolved");
    assert!(matches!(err, ConfigError::KeyUnresolved(_)));

    // Health: last refresh failed and past the TTL window -> unhealthy.
    match handle.health() {
        ConfigHealth::Unhealthy { reason } => {
            assert!(reason.contains("network down") || reason.contains("TTL") || reason.contains("503"))
        }
        ConfigHealth::Healthy => panic!("expected unhealthy"),
    }
}

// ---------------------------------------------------------------------------
// select_mode (§2)
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn select_mode_explicit_container() {
    let _guard = EnvGuard::acquire();
    __reset_select_mode_log_for_tests();
    assert_eq!(
        select_mode(Some(SelectModeInputs {
            mode: Some("container".to_string()),
            ..Default::default()
        })),
        Mode::Container
    );
    assert_eq!(
        select_mode(Some(SelectModeInputs {
            mode: Some("CONTAINER".to_string()),
            ..Default::default()
        })),
        Mode::Container
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn select_mode_blob_present_is_default() {
    let _guard = EnvGuard::acquire();
    assert_eq!(
        select_mode(Some(SelectModeInputs {
            blob_present: Some(true),
            client_id: Some("id".to_string()),
            client_secret: Some("s".to_string()),
            api_url: Some("u".to_string()),
            ..Default::default()
        })),
        Mode::Default
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn select_mode_file_present_is_default() {
    let _guard = EnvGuard::acquire();
    assert_eq!(
        select_mode(Some(SelectModeInputs {
            file_present: Some(true),
            client_id: Some("id".to_string()),
            client_secret: Some("s".to_string()),
            api_url: Some("u".to_string()),
            ..Default::default()
        })),
        Mode::Default
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn select_mode_auto_container_on_m2m_creds() {
    let _guard = EnvGuard::acquire();
    __reset_select_mode_log_for_tests();
    assert_eq!(
        select_mode(Some(SelectModeInputs {
            client_id: Some("id".to_string()),
            client_secret: Some("s".to_string()),
            api_url: Some("u".to_string()),
            ..Default::default()
        })),
        Mode::Container
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn select_mode_incomplete_creds_is_default() {
    let _guard = EnvGuard::acquire();
    assert_eq!(
        select_mode(Some(SelectModeInputs {
            client_id: Some("id".to_string()),
            api_url: Some("u".to_string()),
            ..Default::default()
        })),
        Mode::Default
    );
    assert_eq!(select_mode(Some(SelectModeInputs::default())), Mode::Default);
}

#[tokio::test(flavor = "multi_thread")]
async fn select_mode_reads_from_env() {
    let guard = EnvGuard::acquire();
    guard.set("SMOOAI_CONFIG_MODE", "container");
    assert_eq!(select_mode(None), Mode::Container);
}
