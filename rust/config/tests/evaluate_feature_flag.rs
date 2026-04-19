//! Tests for ConfigClient::evaluate_feature_flag — cohort-aware flag
//! SDK surface (SMOODEV-614). Uses wiremock against a real tokio HTTP
//! server so we exercise the same reqwest path production code does.

use serde_json::json;
use smooai_config::ConfigClient;
use wiremock::matchers::{body_partial_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const TEST_API_KEY: &str = "test-api-key-abc123";
const TEST_ORG_ID: &str = "550e8400-e29b-41d4-a716-446655440000";

fn new_client(base_url: &str) -> ConfigClient {
    ConfigClient::with_environment(base_url, TEST_API_KEY, TEST_ORG_ID, "production")
}

#[tokio::test]
async fn posts_environment_and_context_and_returns_resolved_value() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(format!(
            "/organizations/{}/config/feature-flags/new-dashboard/evaluate",
            TEST_ORG_ID
        )))
        .and(header("authorization", format!("Bearer {}", TEST_API_KEY)))
        .and(body_partial_json(json!({
            "environment": "production",
            "context": { "userId": "u1", "plan": "pro" },
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "value": true,
            "source": "rule",
            "matchedRuleId": "pro-users",
        })))
        .expect(1)
        .mount(&server)
        .await;

    let client = new_client(&server.uri());
    let res = client
        .evaluate_feature_flag("new-dashboard", &json!({ "userId": "u1", "plan": "pro" }), None)
        .await
        .unwrap();

    assert_eq!(res.value, json!(true));
    assert_eq!(res.source, "rule");
    assert_eq!(res.matched_rule_id.as_deref(), Some("pro-users"));
    assert!(res.rollout_bucket.is_none());
}

#[tokio::test]
async fn per_call_environment_override() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(format!(
            "/organizations/{}/config/feature-flags/flag/evaluate",
            TEST_ORG_ID
        )))
        .and(body_partial_json(json!({"environment": "staging"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"value": true, "source": "raw"})))
        .mount(&server)
        .await;

    let client = new_client(&server.uri());
    let res = client
        .evaluate_feature_flag("flag", &json!({}), Some("staging"))
        .await
        .unwrap();
    assert_eq!(res.value, json!(true));
}

#[tokio::test]
async fn not_cached_second_call_hits_server() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(format!(
            "/organizations/{}/config/feature-flags/flag/evaluate",
            TEST_ORG_ID
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "value": true, "source": "rollout", "rolloutBucket": 42,
        })))
        .expect(2)
        .mount(&server)
        .await;

    let client = new_client(&server.uri());
    client
        .evaluate_feature_flag("flag", &json!({"userId": "u1"}), None)
        .await
        .unwrap();
    let res = client
        .evaluate_feature_flag("flag", &json!({"userId": "u1"}), None)
        .await
        .unwrap();
    assert_eq!(res.rollout_bucket, Some(42));
}

#[tokio::test]
async fn propagates_http_errors() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(format!(
            "/organizations/{}/config/feature-flags/missing/evaluate",
            TEST_ORG_ID
        )))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({"message": "not found"})))
        .mount(&server)
        .await;

    let client = new_client(&server.uri());
    let err = client
        .evaluate_feature_flag("missing", &json!({}), None)
        .await
        .unwrap_err();
    assert!(
        err.to_string().to_lowercase().contains("404"),
        "error should mention 404: {}",
        err
    );
}
