//! Environment variable configuration loading.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::cloud_region::get_cloud_region_from_env;
use crate::utils::coerce_boolean;

/// Extract config values from environment variables.
///
/// For each env var:
/// - Strip prefix if present
/// - Check if key is in schema_keys
/// - Coerce types based on schema_types
/// - Sets built-in keys: ENV, IS_LOCAL, REGION, CLOUD_PROVIDER
pub fn find_and_process_env_config(
    schema_keys: &HashSet<String>,
    prefix: &str,
    schema_types: Option<&HashMap<String, String>>,
) -> HashMap<String, Value> {
    let env: HashMap<String, String> = std::env::vars().collect();
    find_and_process_env_config_with_env(schema_keys, prefix, schema_types, &env)
}

/// Extract config values from a provided env map.
pub fn find_and_process_env_config_with_env(
    schema_keys: &HashSet<String>,
    prefix: &str,
    schema_types: Option<&HashMap<String, String>>,
    env: &HashMap<String, String>,
) -> HashMap<String, Value> {
    let cloud_region = get_cloud_region_from_env(env);
    let env_name = env
        .get("SMOOAI_CONFIG_ENV")
        .cloned()
        .unwrap_or_else(|| "development".to_string());
    let is_local = coerce_boolean(env.get("IS_LOCAL").map(|s| s.as_str()).unwrap_or(""));

    let mut result: HashMap<String, Value> = HashMap::new();

    for (key, value) in env {
        let key_to_use = if !prefix.is_empty() && key.starts_with(prefix) {
            &key[prefix.len()..]
        } else {
            key.as_str()
        };

        if !schema_keys.contains(key_to_use) {
            continue;
        }

        // Type coercion
        if let Some(types) = schema_types {
            if let Some(type_hint) = types.get(key_to_use) {
                match type_hint.as_str() {
                    "boolean" => {
                        result.insert(key_to_use.to_string(), Value::Bool(coerce_boolean(value)));
                        continue;
                    }
                    "number" => {
                        if let Ok(n) = value.parse::<f64>() {
                            result.insert(
                                key_to_use.to_string(),
                                serde_json::Number::from_f64(n)
                                    .map(Value::Number)
                                    .unwrap_or(Value::String(value.clone())),
                            );
                            continue;
                        }
                    }
                    "json" | "object" => {
                        if let Ok(parsed) = serde_json::from_str::<Value>(value) {
                            result.insert(key_to_use.to_string(), parsed);
                            continue;
                        }
                    }
                    _ => {}
                }
            }
        }

        result.insert(key_to_use.to_string(), Value::String(value.clone()));
    }

    // Set built-in keys
    result.insert("ENV".to_string(), Value::String(env_name));
    result.insert("IS_LOCAL".to_string(), Value::Bool(is_local));
    result.insert("REGION".to_string(), Value::String(cloud_region.region));
    result.insert("CLOUD_PROVIDER".to_string(), Value::String(cloud_region.provider));

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn keys(names: &[&str]) -> HashSet<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn test_extracts_matching_keys() {
        let schema_keys = keys(&["API_URL", "MAX_RETRIES"]);
        let env = make_env(&[
            ("API_URL", "http://localhost:3000"),
            ("MAX_RETRIES", "3"),
            ("UNRELATED", "ignored"),
        ]);
        let result = find_and_process_env_config_with_env(&schema_keys, "", None, &env);
        assert_eq!(result["API_URL"], Value::String("http://localhost:3000".to_string()));
        assert_eq!(result["MAX_RETRIES"], Value::String("3".to_string()));
        assert!(!result.contains_key("UNRELATED"));
    }

    #[test]
    fn test_strips_prefix() {
        let schema_keys = keys(&["API_URL"]);
        let env = make_env(&[("NEXT_PUBLIC_API_URL", "http://example.com")]);
        let result = find_and_process_env_config_with_env(&schema_keys, "NEXT_PUBLIC_", None, &env);
        assert_eq!(result["API_URL"], Value::String("http://example.com".to_string()));
    }

    #[test]
    fn test_coerces_boolean() {
        let schema_keys = keys(&["ENABLE_DEBUG"]);
        let mut types = HashMap::new();
        types.insert("ENABLE_DEBUG".to_string(), "boolean".to_string());
        let env = make_env(&[("ENABLE_DEBUG", "true")]);
        let result = find_and_process_env_config_with_env(&schema_keys, "", Some(&types), &env);
        assert_eq!(result["ENABLE_DEBUG"], Value::Bool(true));
    }

    #[test]
    fn test_coerces_number() {
        let schema_keys = keys(&["MAX_RETRIES"]);
        let mut types = HashMap::new();
        types.insert("MAX_RETRIES".to_string(), "number".to_string());
        let env = make_env(&[("MAX_RETRIES", "5")]);
        let result = find_and_process_env_config_with_env(&schema_keys, "", Some(&types), &env);
        assert_eq!(result["MAX_RETRIES"], serde_json::json!(5.0));
    }

    #[test]
    fn test_coerces_json() {
        let schema_keys = keys(&["DATABASE"]);
        let mut types = HashMap::new();
        types.insert("DATABASE".to_string(), "json".to_string());
        let env = make_env(&[("DATABASE", r#"{"host":"localhost","port":5432}"#)]);
        let result = find_and_process_env_config_with_env(&schema_keys, "", Some(&types), &env);
        let db = result["DATABASE"].as_object().unwrap();
        assert_eq!(db["host"], serde_json::json!("localhost"));
        assert_eq!(db["port"], serde_json::json!(5432));
    }

    #[test]
    fn test_sets_builtin_keys() {
        let env = make_env(&[("SMOOAI_CONFIG_ENV", "production"), ("AWS_REGION", "us-east-1")]);
        let result = find_and_process_env_config_with_env(&HashSet::new(), "", None, &env);
        assert_eq!(result["ENV"], Value::String("production".to_string()));
        assert_eq!(result["IS_LOCAL"], Value::Bool(false));
        assert_eq!(result["CLOUD_PROVIDER"], Value::String("aws".to_string()));
        assert_eq!(result["REGION"], Value::String("us-east-1".to_string()));
    }
}
