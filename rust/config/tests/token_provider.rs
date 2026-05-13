//! Tests for the OAuth2 `client_credentials` TokenProvider (SMOODEV-975).
//!
//! Parity with src/platform/TokenProvider.test.ts and
//! python/tests/test_token_provider.py. Covers the wire shape, caching,
//! refresh window, invalidate-and-retry, and error paths.

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use smooai_config::{TokenProvider, TokenProviderError};
use wiremock::matchers::{body_partial_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn http_client() -> reqwest::Client {
    reqwest::Client::new()
}

fn make(server: &MockServer, refresh_window: Duration) -> TokenProvider {
    TokenProvider::with_options(
        &server.uri(),
        "test-client-id",
        "test-client-secret",
        refresh_window,
        http_client(),
    )
    .expect("valid arguments")
}

#[tokio::test]
async fn rejects_empty_auth_url() {
    let err = TokenProvider::new("", "cid", "sec").unwrap_err();
    assert!(matches!(err, TokenProviderError::InvalidArgument(_)), "{:?}", err);
}

#[tokio::test]
async fn rejects_empty_client_id() {
    let err = TokenProvider::new("https://auth.example.com", "", "sec").unwrap_err();
    assert!(matches!(err, TokenProviderError::InvalidArgument(_)), "{:?}", err);
}

#[tokio::test]
async fn rejects_empty_client_secret() {
    let err = TokenProvider::new("https://auth.example.com", "cid", "").unwrap_err();
    assert!(matches!(err, TokenProviderError::InvalidArgument(_)), "{:?}", err);
}

#[tokio::test]
async fn posts_client_credentials_form() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .and(header("content-type", "application/x-www-form-urlencoded"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": "minted",
            "expires_in": 3600
        })))
        .expect(1)
        .mount(&server)
        .await;

    let tp = make(&server, Duration::from_secs(60));
    let token = tp.get_access_token().await.unwrap();
    assert_eq!(token, "minted");
}

#[tokio::test]
async fn body_carries_client_id_and_secret() {
    let server = MockServer::start().await;
    // wiremock has no built-in form matcher; we match on the body text via raw bytes.
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": "abc",
            "expires_in": 3600
        })))
        .mount(&server)
        .await;

    let tp = make(&server, Duration::from_secs(60));
    tp.get_access_token().await.unwrap();
    // Verify via the recorded request list.
    let requests = server.received_requests().await.unwrap();
    assert!(!requests.is_empty());
    let body = String::from_utf8(requests[0].body.clone()).unwrap();
    assert!(body.contains("grant_type=client_credentials"));
    assert!(body.contains("provider=client_credentials"));
    assert!(body.contains("client_id=test-client-id"));
    assert!(body.contains("client_secret=test-client-secret"));
}

#[tokio::test]
async fn caches_token_within_expiry_window() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": "cached",
            "expires_in": 3600
        })))
        .expect(1) // exactly one mint despite multiple gets
        .mount(&server)
        .await;

    let tp = make(&server, Duration::from_secs(60));
    for _ in 0..5 {
        assert_eq!(tp.get_access_token().await.unwrap(), "cached");
    }
}

#[tokio::test]
async fn refreshes_when_within_refresh_window() {
    // 10s expiry vs 60s refresh window ⇒ every call refreshes.
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": "short",
            "expires_in": 10
        })))
        .expect(2)
        .mount(&server)
        .await;

    let tp = make(&server, Duration::from_secs(60));
    tp.get_access_token().await.unwrap();
    tp.get_access_token().await.unwrap();
}

#[tokio::test]
async fn invalidate_forces_refresh() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": "t",
            "expires_in": 3600
        })))
        .expect(2)
        .mount(&server)
        .await;

    let tp = make(&server, Duration::from_secs(60));
    tp.get_access_token().await.unwrap();
    tp.invalidate().await;
    tp.get_access_token().await.unwrap();
}

#[tokio::test]
async fn errors_on_non_2xx() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(401).set_body_string("bad creds"))
        .mount(&server)
        .await;

    let tp = make(&server, Duration::from_secs(60));
    let err = tp.get_access_token().await.unwrap_err();
    assert!(
        matches!(err, TokenProviderError::OAuthFailed { status: 401, .. }),
        "{:?}",
        err
    );
}

#[tokio::test]
async fn errors_when_response_lacks_access_token() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"expires_in": 3600})))
        .mount(&server)
        .await;

    let tp = make(&server, Duration::from_secs(60));
    let err = tp.get_access_token().await.unwrap_err();
    assert!(matches!(err, TokenProviderError::MissingAccessToken), "{:?}", err);
}

#[tokio::test]
async fn errors_on_non_json_response() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_string("not json"))
        .mount(&server)
        .await;

    let tp = make(&server, Duration::from_secs(60));
    let err = tp.get_access_token().await.unwrap_err();
    assert!(matches!(err, TokenProviderError::BadJson(_)), "{:?}", err);
}

#[tokio::test]
async fn defaults_expires_in_when_omitted() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"access_token": "tok"})))
        .expect(1)
        .mount(&server)
        .await;

    let tp = make(&server, Duration::from_secs(60));
    // Two calls — the second should hit the cache because expires_in
    // defaulted to 3600s.
    tp.get_access_token().await.unwrap();
    tp.get_access_token().await.unwrap();
}

#[tokio::test]
async fn trims_trailing_slash_on_auth_url() {
    let server = MockServer::start().await;
    let auth_url_with_slashes = format!("{}////", server.uri());
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": "t",
            "expires_in": 3600
        })))
        .mount(&server)
        .await;

    let tp = TokenProvider::with_options(
        &auth_url_with_slashes,
        "cid",
        "sec",
        Duration::from_secs(60),
        http_client(),
    )
    .unwrap();
    tp.get_access_token().await.unwrap();
}

#[tokio::test]
async fn concurrent_callers_share_cache() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(Duration::from_millis(20))
                .set_body_json(json!({"access_token": "shared", "expires_in": 3600})),
        )
        .expect(1) // mutex dedups concurrent callers
        .mount(&server)
        .await;

    let tp = Arc::new(make(&server, Duration::from_secs(60)));
    let mut handles = Vec::new();
    for _ in 0..16 {
        let tp = Arc::clone(&tp);
        handles.push(tokio::spawn(async move {
            assert_eq!(tp.get_access_token().await.unwrap(), "shared");
        }));
    }
    for h in handles {
        h.await.unwrap();
    }
}

// silence unused matcher imports if a future refactor drops the body matcher.
#[allow(dead_code)]
fn _matcher_imports() {
    let _ = body_partial_json(json!({}));
}
