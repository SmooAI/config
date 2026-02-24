//! Local configuration manager with lazy init and multi-tier TTL caching.

use std::collections::{HashMap, HashSet};
use std::sync::RwLock;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::env_config::find_and_process_env_config_with_env;
use crate::file_config::find_and_process_file_config_with_env;
use crate::utils::SmooaiConfigError;

const DEFAULT_TTL_SECS: u64 = 86400; // 24 hours

struct CacheEntry {
    value: Value,
    expires_at: Instant,
}

struct Inner {
    initialized: bool,
    file_config: Option<HashMap<String, Value>>,
    env_config: Option<HashMap<String, Value>>,
    public_cache: HashMap<String, CacheEntry>,
    secret_cache: HashMap<String, CacheEntry>,
    feature_flag_cache: HashMap<String, CacheEntry>,
}

/// Main entry point for local config with lazy init and multi-tier TTL caching.
///
/// Thread-safe via RwLock. Lazy initialization loads file config + env config on first access.
/// Per-key caches with 24h TTL for each tier (public, secret, feature_flag).
/// File config takes precedence over env config.
pub struct LocalConfigManager {
    inner: RwLock<Inner>,
    schema_keys: Option<HashSet<String>>,
    env_prefix: String,
    schema_types: Option<HashMap<String, String>>,
    cache_ttl: Duration,
    env_override: Option<HashMap<String, String>>,
}

impl LocalConfigManager {
    /// Create a new manager with default settings.
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(Inner {
                initialized: false,
                file_config: None,
                env_config: None,
                public_cache: HashMap::new(),
                secret_cache: HashMap::new(),
                feature_flag_cache: HashMap::new(),
            }),
            schema_keys: None,
            env_prefix: String::new(),
            schema_types: None,
            cache_ttl: Duration::from_secs(DEFAULT_TTL_SECS),
            env_override: None,
        }
    }

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

    fn get_env(&self) -> HashMap<String, String> {
        self.env_override.clone().unwrap_or_else(|| std::env::vars().collect())
    }

    fn initialize_inner(&self, inner: &mut Inner) -> Result<(), SmooaiConfigError> {
        if inner.initialized {
            return Ok(());
        }

        let env = self.get_env();

        let file_config = find_and_process_file_config_with_env(&env)?;
        inner.file_config = Some(file_config);

        let schema_keys = self.schema_keys.clone().unwrap_or_default();
        let env_config =
            find_and_process_env_config_with_env(&schema_keys, &self.env_prefix, self.schema_types.as_ref(), &env);
        inner.env_config = Some(env_config);
        inner.initialized = true;

        Ok(())
    }

    fn get_value(
        &self,
        key: &str,
        cache_selector: fn(&mut Inner) -> &mut HashMap<String, CacheEntry>,
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

        // File config takes precedence
        let file_value = inner.file_config.as_ref().and_then(|fc| fc.get(key)).cloned();
        if let Some(value) = file_value {
            let cache = cache_selector(&mut inner);
            cache.insert(
                key.to_string(),
                CacheEntry {
                    value: value.clone(),
                    expires_at: Instant::now() + self.cache_ttl,
                },
            );
            return Ok(Some(value));
        }

        // Env config fallback
        let env_value = inner.env_config.as_ref().and_then(|ec| ec.get(key)).cloned();
        if let Some(value) = env_value {
            let cache = cache_selector(&mut inner);
            cache.insert(
                key.to_string(),
                CacheEntry {
                    value: value.clone(),
                    expires_at: Instant::now() + self.cache_ttl,
                },
            );
            return Ok(Some(value));
        }

        Ok(None)
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
            inner.file_config = None;
            inner.env_config = None;
            inner.public_cache.clear();
            inner.secret_cache.clear();
            inner.feature_flag_cache.clear();
        }
    }
}

impl Default for LocalConfigManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

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

    #[test]
    fn test_lazy_initialization() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = make_config_dir(dir.path(), &[("default.json", r#"{"API_URL":"http://localhost"}"#)]);
        let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test")]);
        let mgr = LocalConfigManager::new().with_env(env);

        assert!(!mgr.inner.read().unwrap().initialized);
        mgr.get_public_config("API_URL").unwrap();
        assert!(mgr.inner.read().unwrap().initialized);
    }

    #[test]
    fn test_get_public_config() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = make_config_dir(
            dir.path(),
            &[("default.json", r#"{"API_URL":"http://localhost","MAX_RETRIES":3}"#)],
        );
        let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test")]);
        let mgr = LocalConfigManager::new().with_env(env);

        assert_eq!(
            mgr.get_public_config("API_URL").unwrap(),
            Some(Value::String("http://localhost".to_string()))
        );
        assert_eq!(
            mgr.get_public_config("MAX_RETRIES").unwrap(),
            Some(serde_json::json!(3))
        );
    }

    #[test]
    fn test_returns_none_for_missing_key() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = make_config_dir(dir.path(), &[("default.json", r#"{"API_URL":"test"}"#)]);
        let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test")]);
        let mgr = LocalConfigManager::new().with_env(env);

        assert_eq!(mgr.get_public_config("NONEXISTENT").unwrap(), None);
    }

    #[test]
    fn test_invalidate() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = make_config_dir(dir.path(), &[("default.json", r#"{"API_URL":"http://localhost"}"#)]);
        let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test")]);
        let mgr = LocalConfigManager::new().with_env(env);

        mgr.get_public_config("API_URL").unwrap();
        assert!(mgr.inner.read().unwrap().initialized);

        mgr.invalidate();
        assert!(!mgr.inner.read().unwrap().initialized);
        assert!(mgr.inner.read().unwrap().public_cache.is_empty());
    }

    #[test]
    fn test_invalidate_allows_reinitialization() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = make_config_dir(dir.path(), &[("default.json", r#"{"API_URL":"http://localhost"}"#)]);
        let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test")]);
        let mgr = LocalConfigManager::new().with_env(env);

        mgr.get_public_config("API_URL").unwrap();
        mgr.invalidate();

        let result = mgr.get_public_config("API_URL").unwrap();
        assert_eq!(result, Some(Value::String("http://localhost".to_string())));
    }
}
