//! File-based configuration loading and merging.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use serde_json::Value;

use crate::cloud_region::get_cloud_region_from_env;
use crate::merge::merge_replace_arrays;
use crate::utils::{coerce_boolean, SmooaiConfigError};

static CONFIG_DIR_CACHE: Mutex<Option<(String, Instant)>> = Mutex::new(None);
const CONFIG_DIR_TTL_SECS: u64 = 3600; // 1 hour

/// Clear the config directory cache (for testing).
pub fn clear_config_dir_cache() {
    if let Ok(mut cache) = CONFIG_DIR_CACHE.lock() {
        *cache = None;
    }
}

/// Find the directory where JSON config files are located.
///
/// Search order:
/// 1. SMOOAI_ENV_CONFIG_DIR env var
/// 2. CWD/.smooai-config or CWD/smooai-config
/// 3. Walk up directory tree (max 5 levels)
pub fn find_config_directory(ignore_cache: bool) -> Result<String, SmooaiConfigError> {
    let env: HashMap<String, String> = std::env::vars().collect();
    find_config_directory_with_env(ignore_cache, &env)
}

/// Find config directory using a provided env map.
pub fn find_config_directory_with_env(
    ignore_cache: bool,
    env: &HashMap<String, String>,
) -> Result<String, SmooaiConfigError> {
    // 1. SMOOAI_ENV_CONFIG_DIR
    if let Some(config_dir) = env.get("SMOOAI_ENV_CONFIG_DIR") {
        if Path::new(config_dir).is_dir() {
            return Ok(config_dir.clone());
        }
        return Err(SmooaiConfigError::new(&format!(
            "The directory specified in SMOOAI_ENV_CONFIG_DIR does not exist: {}",
            config_dir
        )));
    }

    // 2. Check cache
    if !ignore_cache {
        if let Ok(cache) = CONFIG_DIR_CACHE.lock() {
            if let Some((ref dir, instant)) = *cache {
                if instant.elapsed().as_secs() < CONFIG_DIR_TTL_SECS && Path::new(dir).is_dir() {
                    return Ok(dir.clone());
                }
            }
        }
    }

    // 3. CWD candidates
    let cwd = std::env::current_dir()
        .map_err(|e| SmooaiConfigError::new(&format!("Failed to get working directory: {}", e)))?;

    let candidates = [".smooai-config", "smooai-config"];

    for candidate in &candidates {
        let dir = cwd.join(candidate);
        if dir.is_dir() {
            let dir_str = dir.to_string_lossy().to_string();
            if let Ok(mut cache) = CONFIG_DIR_CACHE.lock() {
                *cache = Some((dir_str.clone(), Instant::now()));
            }
            return Ok(dir_str);
        }
    }

    // 4. Walk up
    let levels_up_limit: usize = env
        .get("SMOOAI_CONFIG_LEVELS_UP_LIMIT")
        .and_then(|s| s.parse().ok())
        .unwrap_or(5);

    let mut search_dir = cwd.clone();
    for _ in 0..levels_up_limit {
        let parent = search_dir.parent();
        match parent {
            Some(p) if p != search_dir => search_dir = p.to_path_buf(),
            _ => break, // reached root
        }
        for candidate in &candidates {
            let dir = search_dir.join(candidate);
            if dir.is_dir() {
                let dir_str = dir.to_string_lossy().to_string();
                if let Ok(mut cache) = CONFIG_DIR_CACHE.lock() {
                    *cache = Some((dir_str.clone(), Instant::now()));
                }
                return Ok(dir_str);
            }
        }
    }

    Err(SmooaiConfigError::new(&format!(
        "Could not find config directory, searched {} levels up from {}",
        levels_up_limit,
        cwd.display()
    )))
}

/// Load and merge JSON config files in priority order.
///
/// Merge order:
/// 1. default.json (REQUIRED)
/// 2. local.json (if IS_LOCAL is truthy)
/// 3. {env}.json
/// 4. {env}.{provider}.json
/// 5. {env}.{provider}.{region}.json
pub fn find_and_process_file_config(
    _schema_keys: Option<&HashSet<String>>,
) -> Result<HashMap<String, Value>, SmooaiConfigError> {
    let env: HashMap<String, String> = std::env::vars().collect();
    find_and_process_file_config_with_env(&env)
}

/// Load and merge JSON config files using a provided env map.
pub fn find_and_process_file_config_with_env(
    env: &HashMap<String, String>,
) -> Result<HashMap<String, Value>, SmooaiConfigError> {
    let config_dir = find_config_directory_with_env(false, env)?;
    let config_path = PathBuf::from(&config_dir);

    let is_local = coerce_boolean(env.get("IS_LOCAL").map(|s| s.as_str()).unwrap_or(""));
    let env_name = env
        .get("SMOOAI_CONFIG_ENV")
        .cloned()
        .unwrap_or_else(|| "development".to_string());
    let cloud_region = get_cloud_region_from_env(env);

    // Build file list
    let mut files = vec!["default.json".to_string()];
    if is_local {
        files.push("local.json".to_string());
    }
    if !env_name.is_empty() {
        files.push(format!("{}.json", env_name));
        if cloud_region.provider != "unknown" {
            files.push(format!("{}.{}.json", env_name, cloud_region.provider));
            if cloud_region.region != "unknown" {
                files.push(format!(
                    "{}.{}.{}.json",
                    env_name, cloud_region.provider, cloud_region.region
                ));
            }
        }
    }

    let mut final_config = Value::Object(serde_json::Map::new());

    for file_name in &files {
        let file_path = config_path.join(file_name);
        match fs::read_to_string(&file_path) {
            Ok(content) => {
                let file_config: Value = serde_json::from_str(&content)
                    .map_err(|e| SmooaiConfigError::new(&format!("Error parsing {}: {}", file_path.display(), e)))?;
                final_config = merge_replace_arrays(&final_config, &file_config);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if file_name == "default.json" {
                    return Err(SmooaiConfigError::new(&format!(
                        "Required default.json not found in {}",
                        config_dir
                    )));
                }
                // Optional files skip silently
            }
            Err(e) => {
                return Err(SmooaiConfigError::new(&format!(
                    "Error reading {}: {}",
                    file_path.display(),
                    e
                )));
            }
        }
    }

    // Convert to HashMap
    let mut result: HashMap<String, Value> = match final_config {
        Value::Object(map) => map.into_iter().collect(),
        _ => HashMap::new(),
    };

    // Set built-in keys
    result.insert("ENV".to_string(), Value::String(env_name));
    result.insert("IS_LOCAL".to_string(), Value::Bool(is_local));
    result.insert("REGION".to_string(), Value::String(cloud_region.region));
    result.insert("CLOUD_PROVIDER".to_string(), Value::String(cloud_region.provider));

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_config_dir(dir: &Path, files: &[(&str, &str)]) {
        let config_dir = dir.join(".smooai-config");
        fs::create_dir_all(&config_dir).unwrap();
        for (name, content) in files {
            let mut f = fs::File::create(config_dir.join(name)).unwrap();
            f.write_all(content.as_bytes()).unwrap();
        }
    }

    fn make_env(dir: &Path, extra: &[(&str, &str)]) -> HashMap<String, String> {
        let mut env: HashMap<String, String> = extra.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        env.insert(
            "SMOOAI_ENV_CONFIG_DIR".to_string(),
            dir.join(".smooai-config").to_string_lossy().to_string(),
        );
        env
    }

    #[test]
    fn test_loads_default_json() {
        let dir = tempfile::tempdir().unwrap();
        make_config_dir(
            dir.path(),
            &[("default.json", r#"{"API_URL":"http://localhost:3000","MAX_RETRIES":3}"#)],
        );
        let env = make_env(dir.path(), &[("SMOOAI_CONFIG_ENV", "test")]);
        let result = find_and_process_file_config_with_env(&env).unwrap();
        assert_eq!(result["API_URL"], Value::String("http://localhost:3000".to_string()));
        assert_eq!(result["MAX_RETRIES"], json!(3));
    }

    #[test]
    fn test_raises_without_default() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".smooai-config")).unwrap();
        let env = make_env(dir.path(), &[("SMOOAI_CONFIG_ENV", "test")]);
        let result = find_and_process_file_config_with_env(&env);
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("default.json"));
    }

    #[test]
    fn test_merges_env_specific() {
        let dir = tempfile::tempdir().unwrap();
        make_config_dir(
            dir.path(),
            &[
                ("default.json", r#"{"API_URL":"http://localhost","MAX_RETRIES":3}"#),
                ("development.json", r#"{"API_URL":"http://dev-api.example.com"}"#),
            ],
        );
        let env = make_env(dir.path(), &[("SMOOAI_CONFIG_ENV", "development")]);
        let result = find_and_process_file_config_with_env(&env).unwrap();
        assert_eq!(result["API_URL"], json!("http://dev-api.example.com"));
        assert_eq!(result["MAX_RETRIES"], json!(3));
    }

    #[test]
    fn test_merges_provider_and_region() {
        let dir = tempfile::tempdir().unwrap();
        make_config_dir(
            dir.path(),
            &[
                (
                    "default.json",
                    r#"{"DATABASE":{"host":"localhost","port":5432,"ssl":false}}"#,
                ),
                (
                    "production.json",
                    r#"{"DATABASE":{"host":"prod-db.example.com","port":5432,"ssl":true}}"#,
                ),
                ("production.aws.json", r#"{"DATABASE":{"host":"aws-db.example.com"}}"#),
                (
                    "production.aws.us-east-1.json",
                    r#"{"DATABASE":{"host":"us-east-1-db.example.com"}}"#,
                ),
            ],
        );
        let env = make_env(
            dir.path(),
            &[("SMOOAI_CONFIG_ENV", "production"), ("AWS_REGION", "us-east-1")],
        );
        let result = find_and_process_file_config_with_env(&env).unwrap();
        let db = result["DATABASE"].as_object().unwrap();
        assert_eq!(db["host"], json!("us-east-1-db.example.com"));
        assert_eq!(db["port"], json!(5432));
        assert_eq!(db["ssl"], json!(true));
    }

    #[test]
    fn test_sets_builtin_keys() {
        let dir = tempfile::tempdir().unwrap();
        make_config_dir(dir.path(), &[("default.json", r#"{"API_URL":"test"}"#)]);
        let env = make_env(
            dir.path(),
            &[("SMOOAI_CONFIG_ENV", "production"), ("AWS_REGION", "us-east-1")],
        );
        let result = find_and_process_file_config_with_env(&env).unwrap();
        assert_eq!(result["ENV"], json!("production"));
        assert_eq!(result["IS_LOCAL"], json!(false));
        assert_eq!(result["CLOUD_PROVIDER"], json!("aws"));
        assert_eq!(result["REGION"], json!("us-east-1"));
    }

    use serde_json::json;
}
