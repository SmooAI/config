//! Configuration schema definition using serde.

use serde::{Deserialize, Serialize};

/// Configuration value tiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigTier {
    Public,
    Secret,
    FeatureFlag,
}

/// Result of defining a configuration schema.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigDefinition {
    pub public_schema: serde_json::Value,
    pub secret_schema: serde_json::Value,
    pub feature_flag_schema: serde_json::Value,
    pub json_schema: serde_json::Value,
}

/// Define a configuration schema from JSON schema components.
pub fn define_config(
    public_schema: Option<serde_json::Value>,
    secret_schema: Option<serde_json::Value>,
    feature_flag_schema: Option<serde_json::Value>,
) -> ConfigDefinition {
    let empty_obj = serde_json::json!({"type": "object", "properties": {}});

    let public = public_schema.clone().unwrap_or_default();
    let secret = secret_schema.clone().unwrap_or_default();
    let feature_flags = feature_flag_schema.clone().unwrap_or_default();

    let json_schema = serde_json::json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            "public": public_schema.unwrap_or(empty_obj.clone()),
            "secret": secret_schema.unwrap_or(empty_obj.clone()),
            "feature_flags": feature_flag_schema.unwrap_or(empty_obj),
        }
    });

    ConfigDefinition {
        public_schema: public,
        secret_schema: secret,
        feature_flag_schema: feature_flags,
        json_schema,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_config() {
        let result = define_config(None, None, None);
        assert_eq!(result.public_schema, serde_json::Value::default());
        assert_eq!(result.secret_schema, serde_json::Value::default());
        assert_eq!(result.feature_flag_schema, serde_json::Value::default());
        assert_eq!(result.json_schema["type"], "object");
    }

    #[test]
    fn test_empty_config_has_json_schema_draft() {
        let result = define_config(None, None, None);
        assert_eq!(
            result.json_schema["$schema"],
            "https://json-schema.org/draft/2020-12/schema"
        );
    }

    #[test]
    fn test_empty_config_has_all_tier_properties() {
        let result = define_config(None, None, None);
        let props = &result.json_schema["properties"];
        assert!(props["public"].is_object());
        assert!(props["secret"].is_object());
        assert!(props["feature_flags"].is_object());
    }

    #[test]
    fn test_with_public_schema() {
        let public = serde_json::json!({
            "type": "object",
            "properties": {
                "api_url": {"type": "string"},
                "max_retries": {"type": "integer"}
            }
        });
        let result = define_config(Some(public.clone()), None, None);
        assert_eq!(result.public_schema, public);
        assert_eq!(result.json_schema["properties"]["public"], public);
    }

    #[test]
    fn test_with_secret_schema() {
        let secret = serde_json::json!({
            "type": "object",
            "properties": {
                "api_key": {"type": "string"},
                "jwt_secret": {"type": "string"}
            }
        });
        let result = define_config(None, Some(secret.clone()), None);
        assert_eq!(result.secret_schema, secret);
        assert_eq!(result.json_schema["properties"]["secret"], secret);
        // Public should be empty default
        assert_eq!(result.json_schema["properties"]["public"]["type"], "object");
    }

    #[test]
    fn test_with_feature_flag_schema() {
        let flags = serde_json::json!({
            "type": "object",
            "properties": {
                "enable_new_ui": {"type": "boolean"},
                "beta_features": {"type": "boolean"}
            }
        });
        let result = define_config(None, None, Some(flags.clone()));
        assert_eq!(result.feature_flag_schema, flags);
        assert_eq!(result.json_schema["properties"]["feature_flags"], flags);
    }

    #[test]
    fn test_with_all_tiers() {
        let public = serde_json::json!({"type": "object", "properties": {"url": {"type": "string"}}});
        let secret = serde_json::json!({"type": "object", "properties": {"key": {"type": "string"}}});
        let flags = serde_json::json!({"type": "object", "properties": {"beta": {"type": "boolean"}}});

        let result = define_config(Some(public.clone()), Some(secret.clone()), Some(flags.clone()));
        assert_eq!(result.public_schema, public);
        assert_eq!(result.secret_schema, secret);
        assert_eq!(result.feature_flag_schema, flags);
        assert_eq!(result.json_schema["properties"]["public"], public);
        assert_eq!(result.json_schema["properties"]["secret"], secret);
        assert_eq!(result.json_schema["properties"]["feature_flags"], flags);
    }

    #[test]
    fn test_config_tier_serialization() {
        let tier = ConfigTier::FeatureFlag;
        let json = serde_json::to_string(&tier).unwrap();
        assert_eq!(json, "\"feature_flag\"");
    }

    #[test]
    fn test_config_tier_public_serialization() {
        let json = serde_json::to_string(&ConfigTier::Public).unwrap();
        assert_eq!(json, "\"public\"");
    }

    #[test]
    fn test_config_tier_secret_serialization() {
        let json = serde_json::to_string(&ConfigTier::Secret).unwrap();
        assert_eq!(json, "\"secret\"");
    }

    #[test]
    fn test_config_tier_deserialization() {
        let public: ConfigTier = serde_json::from_str("\"public\"").unwrap();
        assert_eq!(public, ConfigTier::Public);

        let secret: ConfigTier = serde_json::from_str("\"secret\"").unwrap();
        assert_eq!(secret, ConfigTier::Secret);

        let flag: ConfigTier = serde_json::from_str("\"feature_flag\"").unwrap();
        assert_eq!(flag, ConfigTier::FeatureFlag);
    }

    #[test]
    fn test_config_tier_invalid_deserialization() {
        let result: Result<ConfigTier, _> = serde_json::from_str("\"invalid\"");
        assert!(result.is_err());
    }

    #[test]
    fn test_config_definition_serialization_roundtrip() {
        let public = serde_json::json!({"type": "object", "properties": {"url": {"type": "string"}}});
        let result = define_config(Some(public), None, None);
        let json = serde_json::to_string(&result).unwrap();
        let deserialized: ConfigDefinition = serde_json::from_str(&json).unwrap();
        assert_eq!(result.public_schema, deserialized.public_schema);
        assert_eq!(result.json_schema, deserialized.json_schema);
    }

    #[test]
    fn test_complex_nested_schema() {
        let public = serde_json::json!({
            "type": "object",
            "properties": {
                "database": {
                    "type": "object",
                    "properties": {
                        "host": {"type": "string", "default": "localhost"},
                        "port": {"type": "integer", "default": 5432},
                        "options": {
                            "type": "object",
                            "properties": {
                                "ssl": {"type": "boolean"},
                                "pool_size": {"type": "integer"}
                            }
                        }
                    }
                }
            }
        });
        let result = define_config(Some(public.clone()), None, None);
        assert_eq!(
            result.json_schema["properties"]["public"]["properties"]["database"]["properties"]["host"]["type"],
            "string"
        );
    }
}
