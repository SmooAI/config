//! Deep merge utility with array replacement.

use serde_json::Value;

/// Deep merge where arrays replace entirely, objects recurse, primitives overwrite.
pub fn merge_replace_arrays(target: &Value, source: &Value) -> Value {
    match source {
        // Arrays: replace entirely
        Value::Array(_) => source.clone(),

        // Objects: recursive merge
        Value::Object(source_map) => {
            let mut result = match target {
                Value::Object(target_map) => target_map.clone(),
                _ => serde_json::Map::new(),
            };
            for (key, value) in source_map {
                let merged = if let Some(target_value) = result.get(key) {
                    merge_replace_arrays(target_value, value)
                } else {
                    value.clone()
                };
                result.insert(key.clone(), merged);
            }
            Value::Object(result)
        }

        // Primitives: source overwrites
        _ => source.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_string_overwrites_string() {
        assert_eq!(merge_replace_arrays(&json!("old"), &json!("new")), json!("new"));
    }

    #[test]
    fn test_number_overwrites_number() {
        assert_eq!(merge_replace_arrays(&json!(1), &json!(2)), json!(2));
    }

    #[test]
    fn test_bool_overwrites_bool() {
        assert_eq!(merge_replace_arrays(&json!(true), &json!(false)), json!(false));
    }

    #[test]
    fn test_null_overwrites_value() {
        assert_eq!(merge_replace_arrays(&json!("hello"), &json!(null)), json!(null));
    }

    #[test]
    fn test_value_overwrites_null() {
        assert_eq!(merge_replace_arrays(&json!(null), &json!("hello")), json!("hello"));
    }

    #[test]
    fn test_array_replaces_array() {
        assert_eq!(merge_replace_arrays(&json!([1, 2, 3]), &json!([4, 5])), json!([4, 5]));
    }

    #[test]
    fn test_array_replaces_completely() {
        assert_eq!(merge_replace_arrays(&json!([1, 2, 3]), &json!([])), json!([]));
    }

    #[test]
    fn test_array_replaces_non_array() {
        assert_eq!(merge_replace_arrays(&json!("not-array"), &json!([1, 2])), json!([1, 2]));
    }

    #[test]
    fn test_flat_object_merge() {
        let target = json!({"a": 1, "b": 2});
        let source = json!({"b": 3, "c": 4});
        let result = merge_replace_arrays(&target, &source);
        assert_eq!(result, json!({"a": 1, "b": 3, "c": 4}));
    }

    #[test]
    fn test_nested_object_merge() {
        let target = json!({"a": {"x": 1, "y": 2}, "b": 3});
        let source = json!({"a": {"y": 10, "z": 20}});
        let result = merge_replace_arrays(&target, &source);
        assert_eq!(result, json!({"a": {"x": 1, "y": 10, "z": 20}, "b": 3}));
    }

    #[test]
    fn test_deeply_nested_merge() {
        let target = json!({"a": {"b": {"c": 1, "d": 2}}});
        let source = json!({"a": {"b": {"d": 3, "e": 4}}});
        let result = merge_replace_arrays(&target, &source);
        assert_eq!(result, json!({"a": {"b": {"c": 1, "d": 3, "e": 4}}}));
    }

    #[test]
    fn test_object_overwrites_non_object_target() {
        let result = merge_replace_arrays(&json!("not-object"), &json!({"a": 1}));
        assert_eq!(result, json!({"a": 1}));
    }

    #[test]
    fn test_array_in_object_gets_replaced() {
        let target = json!({"a": [1, 2, 3], "b": "keep"});
        let source = json!({"a": [4, 5]});
        let result = merge_replace_arrays(&target, &source);
        assert_eq!(result, json!({"a": [4, 5], "b": "keep"}));
    }

    #[test]
    fn test_nested_array_in_deep_object() {
        let target = json!({"a": {"items": [1, 2, 3], "count": 3}});
        let source = json!({"a": {"items": [10, 20]}});
        let result = merge_replace_arrays(&target, &source);
        assert_eq!(result, json!({"a": {"items": [10, 20], "count": 3}}));
    }

    #[test]
    fn test_primitive_replaces_object() {
        let target = json!({"a": {"x": 1}});
        let source = json!({"a": 42});
        let result = merge_replace_arrays(&target, &source);
        assert_eq!(result, json!({"a": 42}));
    }

    #[test]
    fn test_object_replaces_primitive() {
        let target = json!({"a": 42});
        let source = json!({"a": {"x": 1}});
        let result = merge_replace_arrays(&target, &source);
        assert_eq!(result, json!({"a": {"x": 1}}));
    }

    #[test]
    fn test_empty_source_preserves_target() {
        let target = json!({"a": 1, "b": 2});
        let result = merge_replace_arrays(&target, &json!({}));
        assert_eq!(result, json!({"a": 1, "b": 2}));
    }

    #[test]
    fn test_empty_target_uses_source() {
        let source = json!({"a": 1, "b": 2});
        let result = merge_replace_arrays(&json!({}), &source);
        assert_eq!(result, json!({"a": 1, "b": 2}));
    }

    #[test]
    fn test_both_empty() {
        assert_eq!(merge_replace_arrays(&json!({}), &json!({})), json!({}));
    }

    #[test]
    fn test_partial_database_override() {
        let base = json!({
            "DATABASE": {"host": "prod-db.example.com", "port": 5432, "ssl": true},
            "API_URL": "https://api.example.com"
        });
        let override_val = json!({
            "DATABASE": {"host": "aws-prod-db.example.com"}
        });
        let result = merge_replace_arrays(&base, &override_val);
        assert_eq!(
            result,
            json!({
                "DATABASE": {"host": "aws-prod-db.example.com", "port": 5432, "ssl": true},
                "API_URL": "https://api.example.com"
            })
        );
    }
}
