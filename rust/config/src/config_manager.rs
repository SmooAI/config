//! Unified configuration manager merging file, remote API, and env config sources.
//!
//! Merges three sources in order of precedence (highest to lowest):
//! 1. Environment variables — always win
//! 2. Remote API — authoritative values from server
//! 3. File config — base defaults from JSON files
//!
//! Uses `reqwest::blocking::Client` for synchronous remote fetch, matching the
//! sync pattern of the other SDKs.

use std::collections::{HashMap, HashSet};
use std::sync::RwLock;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::deferred::{resolve_deferred, DeferredValue};
use crate::env_config::find_and_process_env_config_with_env;
use crate::file_config::find_and_process_file_config_with_env;
use crate::merge::merge_replace_arrays;
use crate::utils::SmooaiConfigError;

const DEFAULT_TTL_SECS: u64 = 86400; // 24 hours

struct CacheEntry {
    value: Value,
    expires_at: Instant,
}

struct ManagerInner {
    initialized: bool,
    config: HashMap<String, Value>,
    public_cache: HashMap<String, CacheEntry>,
    secret_cache: HashMap<String, CacheEntry>,
    feature_flag_cache: HashMap<String, CacheEntry>,
}

/// Unified config manager with lazy init and multi-tier TTL caching.
///
/// Thread-safe via RwLock. Lazy initialization loads file config, fetches remote
/// config (if API credentials are available), and loads env config on first access.
/// Per-key caches with configurable TTL for each tier (public, secret, feature_flag).
pub struct ConfigManager {
    inner: RwLock<ManagerInner>,
    // Local config params (immutable after construction)
    schema_keys: Option<HashSet<String>>,
    env_prefix: String,
    schema_types: Option<HashMap<String, String>>,
    cache_ttl: Duration,
    env_override: Option<HashMap<String, String>>,
    // Remote API params (immutable after construction)
    api_key: Option<String>,
    base_url: Option<String>,
    org_id: Option<String>,
    environment: Option<String>,
    // Deferred config values
    deferred: HashMap<String, DeferredValue>,
}

impl ConfigManager {
    /// Create a new manager with default settings.
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(ManagerInner {
                initialized: false,
                config: HashMap::new(),
                public_cache: HashMap::new(),
                secret_cache: HashMap::new(),
                feature_flag_cache: HashMap::new(),
            }),
            schema_keys: None,
            env_prefix: String::new(),
            schema_types: None,
            cache_ttl: Duration::from_secs(DEFAULT_TTL_SECS),
            env_override: None,
            api_key: None,
            base_url: None,
            org_id: None,
            environment: None,
            deferred: HashMap::new(),
        }
    }

    // Remote API builder methods

    /// Set the API key for remote config fetching.
    pub fn with_api_key(mut self, key: &str) -> Self {
        self.api_key = Some(key.to_string());
        self
    }

    /// Set the base URL for the remote config API.
    pub fn with_base_url(mut self, url: &str) -> Self {
        self.base_url = Some(url.to_string());
        self
    }

    /// Set the organization ID for remote config fetching.
    pub fn with_org_id(mut self, id: &str) -> Self {
        self.org_id = Some(id.to_string());
        self
    }

    /// Set the environment name (e.g. "production", "staging").
    pub fn with_environment(mut self, env: &str) -> Self {
        self.environment = Some(env.to_string());
        self
    }

    // Local config builder methods

    /// Set schema keys for env config filtering.
    pub fn with_schema_keys(mut self, keys: HashSet<String>) -> Self {
        self.schema_keys = Some(keys);
        self
    }

    /// Set env var prefix for stripping.
    pub fn with_env_prefix(mut self, prefix: &str) -> Self {
        self.env_prefix = prefix.to_string();
        self
    }

    /// Set schema type hints for coercion.
    pub fn with_schema_types(mut self, types: HashMap<String, String>) -> Self {
        self.schema_types = Some(types);
        self
    }

    /// Set cache TTL.
    pub fn with_cache_ttl(mut self, ttl: Duration) -> Self {
        self.cache_ttl = ttl;
        self
    }

    /// Override environment variables (for testing).
    pub fn with_env(mut self, env: HashMap<String, String>) -> Self {
        self.env_override = Some(env);
        self
    }

    /// Register a deferred (computed) config value.
    ///
    /// The closure receives the full merged config map (pre-resolution snapshot)
    /// and returns the computed value. Deferred values are resolved after all
    /// sources are merged, before the config is made available.
    pub fn with_deferred(mut self, key: &str, resolver: DeferredValue) -> Self {
        self.deferred.insert(key.to_string(), resolver);
        self
    }

    fn get_env(&self) -> HashMap<String, String> {
        self.env_override.clone().unwrap_or_else(|| std::env::vars().collect())
    }

    fn get_env_var(&self, key: &str) -> Option<String> {
        if let Some(ref env) = self.env_override {
            env.get(key).cloned()
        } else {
            std::env::var(key).ok()
        }
    }

    fn resolve_environment(&self) -> String {
        if let Some(ref env) = self.environment {
            return env.clone();
        }
        if let Some(val) = self.get_env_var("SMOOAI_CONFIG_ENV") {
            return val;
        }
        "development".to_string()
    }

    fn resolve_param(&self, env_var: &str, constructor_value: &Option<String>) -> Option<String> {
        // Constructor value takes precedence
        if let Some(ref val) = constructor_value {
            return Some(val.clone());
        }
        // Fall back to env var
        self.get_env_var(env_var)
    }

    fn initialize_inner(&self, inner: &mut ManagerInner) -> Result<(), SmooaiConfigError> {
        if inner.initialized {
            return Ok(());
        }

        let env = self.get_env();

        // 1. Load file config (graceful fallback on error)
        let file_config = find_and_process_file_config_with_env(&env).unwrap_or_default();

        // 2. Load env config
        let schema_keys = self.schema_keys.clone().unwrap_or_default();
        let env_config =
            find_and_process_env_config_with_env(&schema_keys, &self.env_prefix, self.schema_types.as_ref(), &env);

        // 3. Remote fetch if credentials available
        let mut remote_config: HashMap<String, Value> = HashMap::new();
        let api_key = self.resolve_param("SMOOAI_CONFIG_API_KEY", &self.api_key);
        let base_url = self.resolve_param("SMOOAI_CONFIG_API_URL", &self.base_url);
        let org_id = self.resolve_param("SMOOAI_CONFIG_ORG_ID", &self.org_id);

        if let (Some(ref api_key), Some(ref base_url), Some(ref org_id)) = (&api_key, &base_url, &org_id) {
            let env_name = self.resolve_environment();
            let url = format!(
                "{}/organizations/{}/config/values?environment={}",
                base_url.trim_end_matches('/'),
                org_id,
                env_name
            );

            let client = reqwest::blocking::Client::new();
            match client
                .get(&url)
                .header("Authorization", format!("Bearer {}", api_key))
                .send()
            {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(body) = resp.json::<Value>() {
                        if let Some(values) = body.get("values").and_then(|v| v.as_object()) {
                            for (k, v) in values {
                                remote_config.insert(k.clone(), v.clone());
                            }
                        }
                    }
                }
                Ok(resp) => {
                    eprintln!(
                        "[Smooai Config] Warning: Remote config fetch returned HTTP {}",
                        resp.status()
                    );
                }
                Err(e) => {
                    eprintln!("[Smooai Config] Warning: Failed to fetch remote config: {}", e);
                }
            }
        }

        // 4. Merge: file < remote < env (lowest to highest precedence)
        let file_value = serde_json::to_value(&file_config).unwrap_or(Value::Object(Default::default()));
        let remote_value = serde_json::to_value(&remote_config).unwrap_or(Value::Object(Default::default()));
        let env_value = serde_json::to_value(&env_config).unwrap_or(Value::Object(Default::default()));

        let merged = merge_replace_arrays(&Value::Object(Default::default()), &file_value);
        let merged = merge_replace_arrays(&merged, &remote_value);
        let merged = merge_replace_arrays(&merged, &env_value);

        // Convert back to HashMap
        if let Value::Object(map) = merged {
            inner.config = map.into_iter().collect();
        }

        // 5. Resolve deferred/computed values
        if !self.deferred.is_empty() {
            resolve_deferred(&mut inner.config, &self.deferred);
        }

        inner.initialized = true;
        Ok(())
    }

    fn get_value(
        &self,
        key: &str,
        cache_selector: fn(&mut ManagerInner) -> &mut HashMap<String, CacheEntry>,
    ) -> Result<Option<Value>, SmooaiConfigError> {
        let mut inner = self
            .inner
            .write()
            .map_err(|_| SmooaiConfigError::new("Failed to acquire write lock"))?;

        // Check cache
        let cache = cache_selector(&mut inner);
        if let Some(entry) = cache.get(key) {
            if Instant::now() < entry.expires_at {
                return Ok(Some(entry.value.clone()));
            }
            cache.remove(key);
        }

        // Initialize if needed
        self.initialize_inner(&mut inner)?;

        // Look up in merged config
        let value = inner.config.get(key).cloned();
        if let Some(ref val) = value {
            let cache = cache_selector(&mut inner);
            cache.insert(
                key.to_string(),
                CacheEntry {
                    value: val.clone(),
                    expires_at: Instant::now() + self.cache_ttl,
                },
            );
        }

        Ok(value)
    }

    /// Retrieve a public config value.
    pub fn get_public_config(&self, key: &str) -> Result<Option<Value>, SmooaiConfigError> {
        self.get_value(key, |inner| &mut inner.public_cache)
    }

    /// Retrieve a secret config value.
    pub fn get_secret_config(&self, key: &str) -> Result<Option<Value>, SmooaiConfigError> {
        self.get_value(key, |inner| &mut inner.secret_cache)
    }

    /// Retrieve a feature flag value.
    pub fn get_feature_flag(&self, key: &str) -> Result<Option<Value>, SmooaiConfigError> {
        self.get_value(key, |inner| &mut inner.feature_flag_cache)
    }

    /// Clear all caches and force re-initialization on next access.
    pub fn invalidate(&self) {
        if let Ok(mut inner) = self.inner.write() {
            inner.initialized = false;
            inner.config.clear();
            inner.public_cache.clear();
            inner.secret_cache.clear();
            inner.feature_flag_cache.clear();
        }
    }
}

impl Default for ConfigManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::sync::Arc;
    use wiremock::matchers::{header, method, path_regex, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn make_config_dir(dir: &std::path::Path, files: &[(&str, &str)]) -> String {
        let config_dir = dir.join(".smooai-config");
        fs::create_dir_all(&config_dir).unwrap();
        for (name, content) in files {
            let mut f = fs::File::create(config_dir.join(name)).unwrap();
            f.write_all(content.as_bytes()).unwrap();
        }
        config_dir.to_string_lossy().to_string()
    }

    fn make_env(config_dir: &str, extra: &[(&str, &str)]) -> HashMap<String, String> {
        let mut env: HashMap<String, String> = extra.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        env.insert("SMOOAI_ENV_CONFIG_DIR".to_string(), config_dir.to_string());
        env
    }

    // --- Test 1: Local-Only Mode ---
    #[test]
    fn test_local_only_mode() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = make_config_dir(
            dir.path(),
            &[("default.json", r#"{"API_URL":"http://localhost","MAX_RETRIES":3}"#)],
        );
        let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test")]);
        let mgr = ConfigManager::new().with_env(env);

        assert_eq!(
            mgr.get_public_config("API_URL").unwrap(),
            Some(Value::String("http://localhost".to_string()))
        );
        assert_eq!(
            mgr.get_public_config("MAX_RETRIES").unwrap(),
            Some(serde_json::json!(3))
        );
        assert_eq!(mgr.get_public_config("NONEXISTENT").unwrap(), None);
    }

    // --- Test 2: Remote Enrichment ---
    #[tokio::test]
    async fn test_remote_enrichment() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path_regex(r"/organizations/.+/config/values"))
            .and(query_param("environment", "test"))
            .and(header("Authorization", "Bearer test-api-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "values": {
                    "REMOTE_KEY": "remote-value",
                    "REMOTE_NUM": 42
                }
            })))
            .mount(&mock_server)
            .await;

        let url = mock_server.uri();
        let result = tokio::task::spawn_blocking(move || {
            let dir = tempfile::tempdir().unwrap();
            let config_dir = make_config_dir(dir.path(), &[("default.json", r#"{"LOCAL_KEY":"local-value"}"#)]);
            let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test")]);

            let mgr = ConfigManager::new()
                .with_api_key("test-api-key")
                .with_base_url(&url)
                .with_org_id("org-123")
                .with_environment("test")
                .with_env(env);

            let local = mgr.get_public_config("LOCAL_KEY").unwrap();
            let remote = mgr.get_public_config("REMOTE_KEY").unwrap();
            let remote_num = mgr.get_public_config("REMOTE_NUM").unwrap();
            (local, remote, remote_num)
        })
        .await
        .unwrap();

        assert_eq!(result.0, Some(Value::String("local-value".to_string())));
        assert_eq!(result.1, Some(Value::String("remote-value".to_string())));
        assert_eq!(result.2, Some(serde_json::json!(42)));
    }

    // --- Test 3: Merge Precedence (env > remote > file) ---
    #[tokio::test]
    async fn test_merge_precedence() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path_regex(r"/organizations/.+/config/values"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "values": {
                    "API_URL": "http://remote-api",
                    "REMOTE_ONLY": "from-remote"
                }
            })))
            .mount(&mock_server)
            .await;

        let url = mock_server.uri();
        let result = tokio::task::spawn_blocking(move || {
            let dir = tempfile::tempdir().unwrap();
            let config_dir = make_config_dir(
                dir.path(),
                &[(
                    "default.json",
                    r#"{"API_URL":"http://file-api","FILE_ONLY":"from-file"}"#,
                )],
            );

            let mut schema_keys = HashSet::new();
            schema_keys.insert("API_URL".to_string());

            let env = make_env(
                &config_dir,
                &[("SMOOAI_CONFIG_ENV", "test"), ("API_URL", "http://env-api")],
            );

            let mgr = ConfigManager::new()
                .with_api_key("test-key")
                .with_base_url(&url)
                .with_org_id("org-123")
                .with_environment("test")
                .with_schema_keys(schema_keys)
                .with_env(env);

            let api_url = mgr.get_public_config("API_URL").unwrap();
            let remote_only = mgr.get_public_config("REMOTE_ONLY").unwrap();
            let file_only = mgr.get_public_config("FILE_ONLY").unwrap();
            (api_url, remote_only, file_only)
        })
        .await
        .unwrap();

        // Env wins over remote and file
        assert_eq!(result.0, Some(Value::String("http://env-api".to_string())));
        // Remote still accessible
        assert_eq!(result.1, Some(Value::String("from-remote".to_string())));
        // File still accessible
        assert_eq!(result.2, Some(Value::String("from-file".to_string())));
    }

    // --- Test 4: Nested Object Merge ---
    #[tokio::test]
    async fn test_nested_object_merge() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path_regex(r"/organizations/.+/config/values"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "values": {
                    "DATABASE": {"host": "remote-db.example.com", "ssl": true}
                }
            })))
            .mount(&mock_server)
            .await;

        let url = mock_server.uri();
        let result = tokio::task::spawn_blocking(move || {
            let dir = tempfile::tempdir().unwrap();
            let config_dir = make_config_dir(
                dir.path(),
                &[(
                    "default.json",
                    r#"{"DATABASE":{"host":"localhost","port":5432,"ssl":false}}"#,
                )],
            );
            let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test")]);

            let mgr = ConfigManager::new()
                .with_api_key("test-key")
                .with_base_url(&url)
                .with_org_id("org-123")
                .with_environment("test")
                .with_env(env);

            mgr.get_public_config("DATABASE").unwrap()
        })
        .await
        .unwrap();

        let db = result.unwrap();
        let obj = db.as_object().unwrap();
        // Remote overrides host and ssl
        assert_eq!(obj["host"], serde_json::json!("remote-db.example.com"));
        assert_eq!(obj["ssl"], serde_json::json!(true));
        // File's port is preserved
        assert_eq!(obj["port"], serde_json::json!(5432));
    }

    // --- Test 5: Graceful Degradation (500 response) ---
    #[tokio::test]
    async fn test_graceful_degradation_on_server_error() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path_regex(r"/organizations/.+/config/values"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&mock_server)
            .await;

        let url = mock_server.uri();
        let result = tokio::task::spawn_blocking(move || {
            let dir = tempfile::tempdir().unwrap();
            let config_dir = make_config_dir(dir.path(), &[("default.json", r#"{"API_URL":"http://fallback"}"#)]);
            let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test")]);

            let mgr = ConfigManager::new()
                .with_api_key("test-key")
                .with_base_url(&url)
                .with_org_id("org-123")
                .with_environment("test")
                .with_env(env);

            mgr.get_public_config("API_URL").unwrap()
        })
        .await
        .unwrap();

        // Falls back to file config
        assert_eq!(result, Some(Value::String("http://fallback".to_string())));
    }

    // --- Test 6: Three Tiers Independent ---
    #[test]
    fn test_three_tiers_independent() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = make_config_dir(
            dir.path(),
            &[(
                "default.json",
                r#"{"API_URL":"http://localhost","DB_PASS":"secret123","ENABLE_BETA":true}"#,
            )],
        );
        let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test")]);
        let mgr = ConfigManager::new().with_env(env);

        // Each tier sees the same merged config
        assert_eq!(
            mgr.get_public_config("API_URL").unwrap(),
            Some(Value::String("http://localhost".to_string()))
        );
        assert_eq!(
            mgr.get_secret_config("DB_PASS").unwrap(),
            Some(Value::String("secret123".to_string()))
        );
        assert_eq!(mgr.get_feature_flag("ENABLE_BETA").unwrap(), Some(Value::Bool(true)));

        // Each tier has its own cache — accessing same key in different tiers
        // doesn't interfere
        assert_eq!(
            mgr.get_secret_config("API_URL").unwrap(),
            Some(Value::String("http://localhost".to_string()))
        );
    }

    // --- Test 7: Cache Behavior ---
    #[test]
    fn test_cache_behavior() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = make_config_dir(dir.path(), &[("default.json", r#"{"API_URL":"http://localhost"}"#)]);
        let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test")]);
        let mgr = ConfigManager::new()
            .with_cache_ttl(Duration::from_millis(50))
            .with_env(env);

        // First access initializes and caches
        let val1 = mgr.get_public_config("API_URL").unwrap();
        assert_eq!(val1, Some(Value::String("http://localhost".to_string())));

        // Second access should come from cache
        let val2 = mgr.get_public_config("API_URL").unwrap();
        assert_eq!(val2, Some(Value::String("http://localhost".to_string())));

        // Wait for cache to expire
        std::thread::sleep(Duration::from_millis(60));

        // After expiry, still returns the same value (re-reads from merged config)
        let val3 = mgr.get_public_config("API_URL").unwrap();
        assert_eq!(val3, Some(Value::String("http://localhost".to_string())));
    }

    // --- Test 8: API Creds from Env ---
    #[tokio::test]
    async fn test_api_creds_from_env() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path_regex(r"/organizations/env-org-id/config/values"))
            .and(header("Authorization", "Bearer env-api-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "values": {
                    "FROM_REMOTE": "yes"
                }
            })))
            .mount(&mock_server)
            .await;

        let url = mock_server.uri();
        let result = tokio::task::spawn_blocking(move || {
            let dir = tempfile::tempdir().unwrap();
            let config_dir = make_config_dir(dir.path(), &[("default.json", r#"{"LOCAL":"val"}"#)]);
            let env = make_env(
                &config_dir,
                &[
                    ("SMOOAI_CONFIG_ENV", "test"),
                    ("SMOOAI_CONFIG_API_KEY", "env-api-key"),
                    ("SMOOAI_CONFIG_API_URL", &url),
                    ("SMOOAI_CONFIG_ORG_ID", "env-org-id"),
                ],
            );

            // No constructor API params — all from env
            let mgr = ConfigManager::new().with_env(env);
            mgr.get_public_config("FROM_REMOTE").unwrap()
        })
        .await
        .unwrap();

        assert_eq!(result, Some(Value::String("yes".to_string())));
    }

    // --- Test 9: API Creds from Constructor ---
    #[tokio::test]
    async fn test_api_creds_from_constructor() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path_regex(r"/organizations/ctor-org/config/values"))
            .and(header("Authorization", "Bearer ctor-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "values": {
                    "CTOR_REMOTE": "works"
                }
            })))
            .mount(&mock_server)
            .await;

        let url = mock_server.uri();
        let result = tokio::task::spawn_blocking(move || {
            let dir = tempfile::tempdir().unwrap();
            let config_dir = make_config_dir(dir.path(), &[("default.json", r#"{"LOCAL":"val"}"#)]);
            let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test")]);

            let mgr = ConfigManager::new()
                .with_api_key("ctor-key")
                .with_base_url(&url)
                .with_org_id("ctor-org")
                .with_environment("test")
                .with_env(env);

            mgr.get_public_config("CTOR_REMOTE").unwrap()
        })
        .await
        .unwrap();

        assert_eq!(result, Some(Value::String("works".to_string())));
    }

    // --- Test 10: Thread Safety ---
    #[test]
    fn test_thread_safety() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = make_config_dir(
            dir.path(),
            &[("default.json", r#"{"API_URL":"http://localhost","COUNT":42}"#)],
        );
        let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test")]);
        let mgr = Arc::new(ConfigManager::new().with_env(env));

        let mut handles = vec![];
        for _ in 0..10 {
            let mgr = Arc::clone(&mgr);
            handles.push(std::thread::spawn(move || {
                let val = mgr.get_public_config("API_URL").unwrap();
                assert_eq!(val, Some(Value::String("http://localhost".to_string())));
                let count = mgr.get_public_config("COUNT").unwrap();
                assert_eq!(count, Some(serde_json::json!(42)));
            }));
        }

        for handle in handles {
            handle.join().unwrap();
        }
    }

    // --- Test 11: Full Integration (temp dir + mock HTTP + env) ---
    #[tokio::test]
    async fn test_full_integration() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path_regex(r"/organizations/.+/config/values"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "values": {
                    "REMOTE_SETTING": "from-api",
                    "SHARED_KEY": "remote-wins-over-file"
                }
            })))
            .mount(&mock_server)
            .await;

        let url = mock_server.uri();
        let result = tokio::task::spawn_blocking(move || {
            let dir = tempfile::tempdir().unwrap();
            let config_dir = make_config_dir(
                dir.path(),
                &[(
                    "default.json",
                    r#"{"FILE_SETTING":"from-file","SHARED_KEY":"file-value"}"#,
                )],
            );

            let mut schema_keys = HashSet::new();
            schema_keys.insert("SHARED_KEY".to_string());

            let env = make_env(
                &config_dir,
                &[("SMOOAI_CONFIG_ENV", "test"), ("SHARED_KEY", "env-wins-over-all")],
            );

            let mgr = ConfigManager::new()
                .with_api_key("test-key")
                .with_base_url(&url)
                .with_org_id("org-123")
                .with_environment("test")
                .with_schema_keys(schema_keys)
                .with_env(env);

            let file = mgr.get_public_config("FILE_SETTING").unwrap();
            let remote = mgr.get_public_config("REMOTE_SETTING").unwrap();
            let shared = mgr.get_public_config("SHARED_KEY").unwrap();
            (file, remote, shared)
        })
        .await
        .unwrap();

        assert_eq!(result.0, Some(Value::String("from-file".to_string())));
        assert_eq!(result.1, Some(Value::String("from-api".to_string())));
        // Env wins over remote and file
        assert_eq!(result.2, Some(Value::String("env-wins-over-all".to_string())));
    }

    // --- Test 12: Environment Resolution ---
    #[test]
    fn test_environment_resolution_from_constructor() {
        let mgr = ConfigManager::new().with_environment("staging");
        assert_eq!(mgr.resolve_environment(), "staging");
    }

    #[test]
    fn test_environment_resolution_from_env_var() {
        let env: HashMap<String, String> = [("SMOOAI_CONFIG_ENV".to_string(), "production".to_string())]
            .into_iter()
            .collect();
        let mgr = ConfigManager::new().with_env(env);
        assert_eq!(mgr.resolve_environment(), "production");
    }

    #[test]
    fn test_environment_resolution_default() {
        let env: HashMap<String, String> = HashMap::new();
        let mgr = ConfigManager::new().with_env(env);
        assert_eq!(mgr.resolve_environment(), "development");
    }

    #[test]
    fn test_environment_constructor_overrides_env_var() {
        let env: HashMap<String, String> = [("SMOOAI_CONFIG_ENV".to_string(), "from-env".to_string())]
            .into_iter()
            .collect();
        let mgr = ConfigManager::new().with_environment("from-constructor").with_env(env);
        assert_eq!(mgr.resolve_environment(), "from-constructor");
    }

    // --- Test 13: Invalidation Re-fetches ---
    #[tokio::test]
    async fn test_invalidation_refetches() {
        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path_regex(r"/organizations/.+/config/values"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "values": {
                    "DYNAMIC": "value-1"
                }
            })))
            .expect(2) // Should be called twice (initial + after invalidation)
            .mount(&mock_server)
            .await;

        let url = mock_server.uri();
        let result = tokio::task::spawn_blocking(move || {
            let dir = tempfile::tempdir().unwrap();
            let config_dir = make_config_dir(dir.path(), &[("default.json", r#"{"LOCAL":"val"}"#)]);
            let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test")]);

            let mgr = ConfigManager::new()
                .with_api_key("test-key")
                .with_base_url(&url)
                .with_org_id("org-123")
                .with_environment("test")
                .with_env(env);

            // First access
            let val1 = mgr.get_public_config("DYNAMIC").unwrap();

            // Invalidate
            mgr.invalidate();

            // Second access should re-initialize (re-fetch remote)
            let val2 = mgr.get_public_config("DYNAMIC").unwrap();

            (val1, val2)
        })
        .await
        .unwrap();

        assert_eq!(result.0, Some(Value::String("value-1".to_string())));
        assert_eq!(result.1, Some(Value::String("value-1".to_string())));
    }

    // --- Test: Lazy Initialization ---
    #[test]
    fn test_lazy_initialization() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = make_config_dir(dir.path(), &[("default.json", r#"{"API_URL":"http://localhost"}"#)]);
        let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test")]);
        let mgr = ConfigManager::new().with_env(env);

        assert!(!mgr.inner.read().unwrap().initialized);
        mgr.get_public_config("API_URL").unwrap();
        assert!(mgr.inner.read().unwrap().initialized);
    }

    // --- Test: Returns None for Missing Key ---
    #[test]
    fn test_returns_none_for_missing_key() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = make_config_dir(dir.path(), &[("default.json", r#"{"API_URL":"test"}"#)]);
        let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test")]);
        let mgr = ConfigManager::new().with_env(env);

        assert_eq!(mgr.get_public_config("NONEXISTENT").unwrap(), None);
    }

    // --- Test: Invalidate Clears State ---
    #[test]
    fn test_invalidate_clears_state() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = make_config_dir(dir.path(), &[("default.json", r#"{"API_URL":"http://localhost"}"#)]);
        let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test")]);
        let mgr = ConfigManager::new().with_env(env);

        mgr.get_public_config("API_URL").unwrap();
        assert!(mgr.inner.read().unwrap().initialized);

        mgr.invalidate();
        assert!(!mgr.inner.read().unwrap().initialized);
        assert!(mgr.inner.read().unwrap().public_cache.is_empty());
        assert!(mgr.inner.read().unwrap().config.is_empty());
    }

    // --- Test: Invalidate Allows Reinitialization ---
    #[test]
    fn test_invalidate_allows_reinitialization() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = make_config_dir(dir.path(), &[("default.json", r#"{"API_URL":"http://localhost"}"#)]);
        let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test")]);
        let mgr = ConfigManager::new().with_env(env);

        mgr.get_public_config("API_URL").unwrap();
        mgr.invalidate();

        let result = mgr.get_public_config("API_URL").unwrap();
        assert_eq!(result, Some(Value::String("http://localhost".to_string())));
    }

    // --- Test: Basic Deferred Value ---
    #[test]
    fn test_basic_deferred_value() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = make_config_dir(dir.path(), &[("default.json", r#"{"HOST":"localhost","PORT":5432}"#)]);
        let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test")]);

        let mgr = ConfigManager::new().with_env(env).with_deferred(
            "FULL_URL",
            Box::new(|config| {
                let host = config["HOST"].as_str().unwrap_or("unknown");
                let port = config["PORT"].as_u64().unwrap_or(0);
                serde_json::json!(format!("{}:{}", host, port))
            }),
        );

        assert_eq!(
            mgr.get_public_config("FULL_URL").unwrap(),
            Some(serde_json::json!("localhost:5432"))
        );
        // Original values preserved
        assert_eq!(
            mgr.get_public_config("HOST").unwrap(),
            Some(serde_json::json!("localhost"))
        );
        assert_eq!(mgr.get_public_config("PORT").unwrap(), Some(serde_json::json!(5432)));
    }

    // --- Test: Multiple Deferred See Pre-Resolution Snapshot ---
    #[test]
    fn test_multiple_deferred_see_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = make_config_dir(dir.path(), &[("default.json", r#"{"BASE":"hello"}"#)]);
        let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test")]);

        let mgr = ConfigManager::new()
            .with_env(env)
            .with_deferred(
                "A",
                Box::new(|config| {
                    let base = config["BASE"].as_str().unwrap_or("");
                    serde_json::json!(format!("{}-a", base))
                }),
            )
            .with_deferred(
                "B",
                Box::new(|config| {
                    // B should NOT see A's resolved value
                    serde_json::json!(config.contains_key("A"))
                }),
            );

        assert_eq!(mgr.get_public_config("A").unwrap(), Some(serde_json::json!("hello-a")));
        // B should see that A was NOT in the snapshot
        assert_eq!(mgr.get_public_config("B").unwrap(), Some(serde_json::json!(false)));
    }

    // --- Test: Deferred Runs After Full Merge ---
    #[test]
    fn test_deferred_runs_after_merge() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = make_config_dir(dir.path(), &[("default.json", r#"{"HOST":"file-host"}"#)]);

        let mut schema_keys = HashSet::new();
        schema_keys.insert("HOST".to_string());

        let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test"), ("HOST", "env-host")]);

        let mgr = ConfigManager::new()
            .with_env(env)
            .with_schema_keys(schema_keys)
            .with_deferred(
                "API_URL",
                Box::new(|config| {
                    let host = config["HOST"].as_str().unwrap_or("unknown");
                    serde_json::json!(format!("https://{}/api", host))
                }),
            );

        // Env overrides file, deferred sees env value
        assert_eq!(
            mgr.get_public_config("API_URL").unwrap(),
            Some(serde_json::json!("https://env-host/api"))
        );
    }

    // --- Test: No Remote Without Credentials ---
    #[test]
    fn test_no_remote_without_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = make_config_dir(dir.path(), &[("default.json", r#"{"API_URL":"http://localhost"}"#)]);
        let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test")]);

        // No API key, base URL, or org ID — should work fine with just local config
        let mgr = ConfigManager::new().with_env(env);

        assert_eq!(
            mgr.get_public_config("API_URL").unwrap(),
            Some(Value::String("http://localhost".to_string()))
        );
    }

    // --- Test: Graceful Fallback When No Config Files ---
    #[test]
    fn test_graceful_fallback_no_config_files() {
        // Point to a directory with no config files
        let dir = tempfile::tempdir().unwrap();
        let empty_dir = dir.path().join("empty");
        fs::create_dir_all(&empty_dir).unwrap();

        let env: HashMap<String, String> = [(
            "SMOOAI_ENV_CONFIG_DIR".to_string(),
            empty_dir.to_string_lossy().to_string(),
        )]
        .into_iter()
        .collect();

        let mgr = ConfigManager::new().with_env(env);

        // Should not error — file config failure is graceful
        let result = mgr.get_public_config("ANYTHING").unwrap();
        assert_eq!(result, None);
    }

    // --- Test: Constructor Params Override Env Vars ---
    #[tokio::test]
    async fn test_constructor_params_override_env_vars() {
        let mock_server = MockServer::start().await;

        // The mock expects the constructor org ID, not the env var one
        Mock::given(method("GET"))
            .and(path_regex(r"/organizations/ctor-org/config/values"))
            .and(header("Authorization", "Bearer ctor-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "values": {"RESULT": "from-ctor-params"}
            })))
            .mount(&mock_server)
            .await;

        let url = mock_server.uri();
        let result = tokio::task::spawn_blocking(move || {
            let dir = tempfile::tempdir().unwrap();
            let config_dir = make_config_dir(dir.path(), &[("default.json", r#"{"L":"v"}"#)]);
            let env = make_env(
                &config_dir,
                &[
                    ("SMOOAI_CONFIG_ENV", "test"),
                    ("SMOOAI_CONFIG_API_KEY", "env-key"),
                    ("SMOOAI_CONFIG_API_URL", "http://should-not-use"),
                    ("SMOOAI_CONFIG_ORG_ID", "env-org"),
                ],
            );

            let mgr = ConfigManager::new()
                .with_api_key("ctor-key")
                .with_base_url(&url)
                .with_org_id("ctor-org")
                .with_environment("test")
                .with_env(env);

            mgr.get_public_config("RESULT").unwrap()
        })
        .await
        .unwrap();

        assert_eq!(result, Some(Value::String("from-ctor-params".to_string())));
    }
}
