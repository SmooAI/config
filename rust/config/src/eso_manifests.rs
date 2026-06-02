//! ESO (ExternalSecrets Operator) manifest generator — Rust parity port of the
//! TypeScript `src/eso-manifests` (SMOODEV-1526, epic SMOODEV-1522).
//!
//! Emits the two ESO resources that let a Kubernetes workload pull its secrets
//! from the @smooai/config HTTP API (api.smoo.ai) instead of having them baked
//! at deploy time:
//!
//! 1. [`build_cluster_secret_store`] — a `ClusterSecretStore` whose webhook
//!    provider points at the real config-values endpoint (org + env baked into
//!    the URL, bearer from the bootstrap Secret the eso-refresher keeps fresh).
//! 2. [`build_external_secret`] — a per-workload `ExternalSecret` mapping
//!    secret-tier config keys to env-var names (UPPER_SNAKE_CASE by default,
//!    overridable).
//!
//! Returns `serde_json::Value` (cdk8s / kubectl / YAML all accept it). No
//! cluster or network access.

use serde_json::{json, Value};
use std::collections::HashSet;

use crate::utils::{camel_to_upper_snake, SmooaiConfigError};

pub const ESO_DEFAULT_CLUSTER_SECRET_STORE_NAME: &str = "smooai-config";
pub const ESO_DEFAULT_BOOTSTRAP_SECRET_NAME: &str = "smooai-config-bootstrap";
pub const ESO_DEFAULT_BOOTSTRAP_SECRET_NAMESPACE: &str = "external-secrets";
pub const ESO_DEFAULT_BOOTSTRAP_SECRET_KEY: &str = "bearer-token";
pub const ESO_DEFAULT_REFRESH_INTERVAL: &str = "1h";
pub const ESO_API_VERSION: &str = "external-secrets.io/v1beta1";

/// Reference to the k8s Secret + key holding the ESO bearer token.
#[derive(Debug, Clone)]
pub struct BootstrapSecretRef {
    pub name: String,
    pub namespace: String,
    pub key: String,
}

impl Default for BootstrapSecretRef {
    fn default() -> Self {
        Self {
            name: ESO_DEFAULT_BOOTSTRAP_SECRET_NAME.to_string(),
            namespace: ESO_DEFAULT_BOOTSTRAP_SECRET_NAMESPACE.to_string(),
            key: ESO_DEFAULT_BOOTSTRAP_SECRET_KEY.to_string(),
        }
    }
}

/// Options for [`build_cluster_secret_store`].
#[derive(Debug, Clone)]
pub struct ClusterSecretStoreOptions {
    /// ClusterSecretStore name; defaults to `smooai-config`.
    pub name: Option<String>,
    /// Config API base URL, e.g. `https://api.smoo.ai` (required).
    pub api_url: String,
    /// Org id whose config this store reads (required).
    pub org_id: String,
    /// Environment baked into the query string (required).
    pub environment: String,
    pub bootstrap_secret: Option<BootstrapSecretRef>,
}

/// Build a `ClusterSecretStore` backed by the @smooai/config webhook provider.
///
/// org + environment are baked into the URL because ESO's webhook only templates
/// `{{ .remoteRef.key }}` per-secret — so a store is scoped to one (org, env).
pub fn build_cluster_secret_store(
    opts: &ClusterSecretStoreOptions,
) -> Result<Value, SmooaiConfigError> {
    if opts.api_url.is_empty() {
        return Err(SmooaiConfigError::new(
            "build_cluster_secret_store: api_url is required",
        ));
    }
    if opts.org_id.is_empty() {
        return Err(SmooaiConfigError::new(
            "build_cluster_secret_store: org_id is required",
        ));
    }
    if opts.environment.is_empty() {
        return Err(SmooaiConfigError::new(
            "build_cluster_secret_store: environment is required",
        ));
    }

    let name = opts
        .name
        .clone()
        .unwrap_or_else(|| ESO_DEFAULT_CLUSTER_SECRET_STORE_NAME.to_string());
    let api_url = opts.api_url.trim_end_matches('/');
    let r = opts.bootstrap_secret.clone().unwrap_or_default();

    let url = format!(
        "{}/organizations/{}/config/values/{{{{ .remoteRef.key }}}}?environment={}",
        api_url,
        opts.org_id,
        encode_query_component(&opts.environment)
    );

    Ok(json!({
        "apiVersion": ESO_API_VERSION,
        "kind": "ClusterSecretStore",
        "metadata": { "name": name },
        "spec": {
            "provider": {
                "webhook": {
                    "url": url,
                    "headers": {
                        "Content-Type": "application/json",
                        "Authorization": "Bearer {{ .auth.token }}"
                    },
                    "result": { "jsonPath": "$.value" },
                    "secrets": [
                        {
                            "name": "auth",
                            "secretRef": {
                                "name": r.name,
                                "namespace": r.namespace,
                                "key": r.key
                            }
                        }
                    ]
                }
            }
        }
    }))
}

/// A config key → the env-var name the workload reads. `env_var` defaults to
/// `UPPER_SNAKE_CASE(config_key)`.
#[derive(Debug, Clone)]
pub struct SecretMapping {
    pub config_key: String,
    pub env_var: Option<String>,
}

impl SecretMapping {
    pub fn new(config_key: impl Into<String>) -> Self {
        Self {
            config_key: config_key.into(),
            env_var: None,
        }
    }

    pub fn with_env_var(config_key: impl Into<String>, env_var: impl Into<String>) -> Self {
        Self {
            config_key: config_key.into(),
            env_var: Some(env_var.into()),
        }
    }
}

/// Normalize a mapping, defaulting `env_var` to the snakecase of `config_key`.
/// Returns `(config_key, env_var)`.
pub fn resolve_secret_mapping(m: &SecretMapping) -> Result<(String, String), SmooaiConfigError> {
    if m.config_key.is_empty() {
        return Err(SmooaiConfigError::new(
            "resolve_secret_mapping: config_key is required",
        ));
    }
    let env_var = m
        .env_var
        .clone()
        .unwrap_or_else(|| camel_to_upper_snake(&m.config_key));
    Ok((m.config_key.clone(), env_var))
}

/// Options for [`build_external_secret`].
#[derive(Debug, Clone)]
pub struct ExternalSecretOptions {
    pub name: String,
    pub namespace: String,
    pub secrets: Vec<SecretMapping>,
    pub target_secret_name: Option<String>,
    pub cluster_secret_store_name: Option<String>,
    pub refresh_interval: Option<String>,
    pub labels: Option<std::collections::BTreeMap<String, String>>,
}

/// Build a per-workload `ExternalSecret`. Each entry becomes a data mapping of
/// `secretKey` (the env-var name in the synced Secret) ← `remoteRef.key` (the
/// @smooai/config key).
pub fn build_external_secret(opts: &ExternalSecretOptions) -> Result<Value, SmooaiConfigError> {
    if opts.name.is_empty() {
        return Err(SmooaiConfigError::new(
            "build_external_secret: name is required",
        ));
    }
    if opts.namespace.is_empty() {
        return Err(SmooaiConfigError::new(
            "build_external_secret: namespace is required",
        ));
    }
    if opts.secrets.is_empty() {
        return Err(SmooaiConfigError::new(
            "build_external_secret: at least one secret mapping is required",
        ));
    }

    let mut data: Vec<Value> = Vec::with_capacity(opts.secrets.len());
    let mut seen: HashSet<String> = HashSet::new();
    for entry in &opts.secrets {
        let (config_key, env_var) = resolve_secret_mapping(entry)?;
        if !seen.insert(env_var.clone()) {
            return Err(SmooaiConfigError::new(&format!(
                "build_external_secret: duplicate env-var name: {env_var}"
            )));
        }
        data.push(json!({ "secretKey": env_var, "remoteRef": { "key": config_key } }));
    }

    let target_name = opts
        .target_secret_name
        .clone()
        .unwrap_or_else(|| opts.name.clone());
    let store_name = opts
        .cluster_secret_store_name
        .clone()
        .unwrap_or_else(|| ESO_DEFAULT_CLUSTER_SECRET_STORE_NAME.to_string());
    let refresh = opts
        .refresh_interval
        .clone()
        .unwrap_or_else(|| ESO_DEFAULT_REFRESH_INTERVAL.to_string());

    let mut metadata = json!({ "name": opts.name, "namespace": opts.namespace });
    if let Some(labels) = &opts.labels {
        if !labels.is_empty() {
            metadata["labels"] = json!(labels);
        }
    }

    Ok(json!({
        "apiVersion": ESO_API_VERSION,
        "kind": "ExternalSecret",
        "metadata": metadata,
        "spec": {
            "refreshInterval": refresh,
            "secretStoreRef": { "name": store_name, "kind": "ClusterSecretStore" },
            "target": { "name": target_name, "creationPolicy": "Owner" },
            "data": data
        }
    }))
}

/// Percent-encode a query-string component (mirrors JS `encodeURIComponent`).
fn encode_query_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push_str("%20"),
            _ => {
                out.push('%');
                out.push_str(&format!("{b:02X}"));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_opts() -> ClusterSecretStoreOptions {
        ClusterSecretStoreOptions {
            name: None,
            api_url: "https://api.smoo.ai".to_string(),
            org_id: "org-123".to_string(),
            environment: "production".to_string(),
            bootstrap_secret: None,
        }
    }

    #[test]
    fn cluster_store_bakes_org_and_env() {
        let s = build_cluster_secret_store(&store_opts()).unwrap();
        let url = s["spec"]["provider"]["webhook"]["url"].as_str().unwrap();
        assert_eq!(
            url,
            "https://api.smoo.ai/organizations/org-123/config/values/{{ .remoteRef.key }}?environment=production"
        );
        assert!(!url.contains("config.smoo.ai"));
        assert_eq!(s["spec"]["provider"]["webhook"]["result"]["jsonPath"], "$.value");
    }

    #[test]
    fn cluster_store_defaults_and_encoding() {
        let mut o = store_opts();
        o.api_url = "https://api.smoo.ai///".to_string();
        o.environment = "pre prod".to_string();
        let s = build_cluster_secret_store(&o).unwrap();
        let url = s["spec"]["provider"]["webhook"]["url"].as_str().unwrap();
        assert!(url.starts_with("https://api.smoo.ai/organizations"));
        assert!(url.contains("environment=pre%20prod"));
        let r = &s["spec"]["provider"]["webhook"]["secrets"][0]["secretRef"];
        assert_eq!(r["name"], "smooai-config-bootstrap");
        assert_eq!(r["namespace"], "external-secrets");
        assert_eq!(r["key"], "bearer-token");
    }

    #[test]
    fn cluster_store_required_fields() {
        let mut o = store_opts();
        o.api_url = String::new();
        assert!(build_cluster_secret_store(&o).is_err());
    }

    #[test]
    fn resolve_mapping_defaults_and_override() {
        let (_, env) = resolve_secret_mapping(&SecretMapping::new("mimoApiKey")).unwrap();
        assert_eq!(env, "MIMO_API_KEY");
        let (_, env2) =
            resolve_secret_mapping(&SecretMapping::with_env_var("alibabaModelStudioApiKey", "DASHSCOPE_API_KEY")).unwrap();
        assert_eq!(env2, "DASHSCOPE_API_KEY");
    }

    #[test]
    fn external_secret_maps_keys() {
        let es = build_external_secret(&ExternalSecretOptions {
            name: "litellm-config".to_string(),
            namespace: "smooai-litellm".to_string(),
            secrets: vec![
                SecretMapping::new("mimoApiKey"),
                SecretMapping::with_env_var("alibabaModelStudioApiKey", "DASHSCOPE_API_KEY"),
            ],
            target_secret_name: None,
            cluster_secret_store_name: None,
            refresh_interval: None,
            labels: None,
        })
        .unwrap();
        assert_eq!(es["spec"]["data"][0]["secretKey"], "MIMO_API_KEY");
        assert_eq!(es["spec"]["data"][0]["remoteRef"]["key"], "mimoApiKey");
        assert_eq!(es["spec"]["data"][1]["secretKey"], "DASHSCOPE_API_KEY");
        assert_eq!(es["spec"]["target"]["name"], "litellm-config");
        assert_eq!(es["spec"]["secretStoreRef"]["name"], "smooai-config");
    }

    #[test]
    fn external_secret_duplicate_env_var() {
        let err = build_external_secret(&ExternalSecretOptions {
            name: "x".to_string(),
            namespace: "ns".to_string(),
            secrets: vec![
                SecretMapping::new("mimoApiKey"),
                SecretMapping::with_env_var("somethingElse", "MIMO_API_KEY"),
            ],
            target_secret_name: None,
            cluster_secret_store_name: None,
            refresh_interval: None,
            labels: None,
        });
        assert!(err.is_err());
        assert!(err.unwrap_err().to_string().contains("duplicate env-var"));
    }
}
