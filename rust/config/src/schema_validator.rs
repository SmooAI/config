//! Cross-language JSON Schema validation for the Smoo AI config SDK.
//!
//! Validates that a JSON Schema uses only the subset of keywords that all
//! four language SDKs (TypeScript, Python, Rust, Go) can reliably support.

use serde_json::Value;

/// A single validation error with actionable context.
#[derive(Debug, Clone)]
pub struct SchemaValidationError {
    pub path: String,
    pub keyword: String,
    pub message: String,
    pub suggestion: String,
}

/// Result of schema validation.
#[derive(Debug, Clone)]
pub struct SchemaValidationResult {
    pub valid: bool,
    pub errors: Vec<SchemaValidationError>,
}

/// Keywords supported across all four SDK languages.
const SUPPORTED_KEYWORDS: &[&str] = &[
    // Core
    "type",
    "properties",
    "required",
    "enum",
    "const",
    "default",
    // Metadata
    "title",
    "description",
    "$schema",
    // String
    "minLength",
    "maxLength",
    "pattern",
    "format",
    // Numeric
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    // Array
    "items",
    "minItems",
    "maxItems",
    "uniqueItems",
    // Object
    "additionalProperties",
    // Composition
    "anyOf",
    "oneOf",
    "allOf",
    // References
    "$ref",
    "$defs",
    "definitions",
];

/// Formats supported across all four SDKs.
const SUPPORTED_FORMATS: &[&str] = &["email", "uri", "uuid", "date-time", "ipv4", "ipv6"];

struct RejectedKeyword {
    keyword: &'static str,
    message: &'static str,
    suggestion: &'static str,
}

const REJECTED_KEYWORDS: &[RejectedKeyword] = &[
    RejectedKeyword {
        keyword: "if",
        message: "Conditional schemas (if/then/else) are not supported across all SDK languages.",
        suggestion: "Use \"oneOf\" or \"anyOf\" with discriminator properties instead.",
    },
    RejectedKeyword {
        keyword: "then",
        message: "Conditional schemas (if/then/else) are not supported across all SDK languages.",
        suggestion: "Use \"oneOf\" or \"anyOf\" with discriminator properties instead.",
    },
    RejectedKeyword {
        keyword: "else",
        message: "Conditional schemas (if/then/else) are not supported across all SDK languages.",
        suggestion: "Use \"oneOf\" or \"anyOf\" with discriminator properties instead.",
    },
    RejectedKeyword {
        keyword: "patternProperties",
        message: "\"patternProperties\" is not supported across all SDK languages.",
        suggestion:
            "Use explicit \"properties\" with known key names, or \"additionalProperties\" with a type constraint.",
    },
    RejectedKeyword {
        keyword: "propertyNames",
        message: "\"propertyNames\" is not supported across all SDK languages.",
        suggestion: "Validate property names in application code instead.",
    },
    RejectedKeyword {
        keyword: "dependencies",
        message: "\"dependencies\" is not supported across all SDK languages.",
        suggestion: "Use \"required\" within \"oneOf\"/\"anyOf\" variants to express conditional requirements.",
    },
    RejectedKeyword {
        keyword: "contains",
        message: "\"contains\" is not supported across all SDK languages.",
        suggestion: "Use \"items\" with a union type (\"anyOf\") instead.",
    },
    RejectedKeyword {
        keyword: "not",
        message: "\"not\" is not supported across all SDK languages.",
        suggestion: "Express the constraint positively using \"enum\", \"oneOf\", or validation in application code.",
    },
    RejectedKeyword {
        keyword: "prefixItems",
        message: "\"prefixItems\" (tuple validation) is not supported across all SDK languages.",
        suggestion: "Use an \"object\" with named fields instead of a positional tuple.",
    },
    RejectedKeyword {
        keyword: "unevaluatedProperties",
        message: "\"unevaluatedProperties\" is not supported across all SDK languages.",
        suggestion: "Use \"additionalProperties\" instead.",
    },
    RejectedKeyword {
        keyword: "unevaluatedItems",
        message: "\"unevaluatedItems\" is not supported across all SDK languages.",
        suggestion: "Use \"items\" with a specific schema instead.",
    },
];

/// Validate that a JSON Schema uses only the cross-language-compatible subset.
pub fn validate_smooai_schema(schema: &Value) -> SchemaValidationResult {
    let mut errors = Vec::new();
    walk_schema(schema, "", &mut errors);
    SchemaValidationResult {
        valid: errors.is_empty(),
        errors,
    }
}

fn find_rejected(keyword: &str) -> Option<&'static RejectedKeyword> {
    REJECTED_KEYWORDS.iter().find(|r| r.keyword == keyword)
}

fn walk_schema(node: &Value, path: &str, errors: &mut Vec<SchemaValidationError>) {
    let obj = match node.as_object() {
        Some(o) => o,
        None => return,
    };

    for key in obj.keys() {
        // Check for rejected keywords first
        if let Some(rejected) = find_rejected(key) {
            errors.push(SchemaValidationError {
                path: if path.is_empty() {
                    "/".to_string()
                } else {
                    path.to_string()
                },
                keyword: key.clone(),
                message: rejected.message.to_string(),
                suggestion: rejected.suggestion.to_string(),
            });
            continue;
        }

        // Skip supported keywords
        if SUPPORTED_KEYWORDS.contains(&key.as_str()) {
            // Validate format values
            if key == "format" {
                if let Some(fmt) = obj[key].as_str() {
                    if !SUPPORTED_FORMATS.contains(&fmt) {
                        errors.push(SchemaValidationError {
                            path: if path.is_empty() {
                                "/".to_string()
                            } else {
                                path.to_string()
                            },
                            keyword: "format".to_string(),
                            message: format!("Format \"{}\" is not supported across all SDK languages.", fmt),
                            suggestion: format!(
                                "Supported formats: {}. Use \"pattern\" for custom string validation.",
                                SUPPORTED_FORMATS.join(", ")
                            ),
                        });
                    }
                }
            }
            continue;
        }
    }

    // Recurse into sub-schemas
    if let Some(props) = obj.get("properties").and_then(|v| v.as_object()) {
        for (prop_name, prop_schema) in props {
            walk_schema(prop_schema, &format!("{}/properties/{}", path, prop_name), errors);
        }
    }

    if let Some(items) = obj.get("items") {
        if items.is_object() {
            walk_schema(items, &format!("{}/items", path), errors);
        }
    }

    if let Some(additional) = obj.get("additionalProperties") {
        if additional.is_object() && !additional.is_boolean() {
            walk_schema(additional, &format!("{}/additionalProperties", path), errors);
        }
    }

    // Composition keywords
    for comp_key in &["anyOf", "oneOf", "allOf"] {
        if let Some(arr) = obj.get(*comp_key).and_then(|v| v.as_array()) {
            for (i, sub_schema) in arr.iter().enumerate() {
                walk_schema(sub_schema, &format!("{}/{}/{}", path, comp_key, i), errors);
            }
        }
    }

    // $defs / definitions
    for defs_key in &["$defs", "definitions"] {
        if let Some(defs) = obj.get(*defs_key).and_then(|v| v.as_object()) {
            for (def_name, def_schema) in defs {
                walk_schema(def_schema, &format!("{}/{}/{}", path, defs_key, def_name), errors);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::path::Path;

    #[derive(serde::Deserialize)]
    struct ValidCase {
        name: String,
        schema: Value,
    }

    #[derive(serde::Deserialize)]
    struct InvalidCase {
        name: String,
        schema: Value,
        expected_keywords: Vec<String>,
    }

    #[derive(serde::Deserialize)]
    struct TestFixtures {
        valid: Vec<ValidCase>,
        invalid: Vec<InvalidCase>,
    }

    fn load_fixtures() -> TestFixtures {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-fixtures/schema-validation-cases.json");
        let content = fs::read_to_string(path).expect("Failed to read test fixtures");
        serde_json::from_str(&content).expect("Failed to parse test fixtures")
    }

    #[test]
    fn test_valid_schemas_from_fixtures() {
        let fixtures = load_fixtures();
        for case in &fixtures.valid {
            let result = validate_smooai_schema(&case.schema);
            assert!(
                result.valid,
                "Expected valid but got errors for '{}': {:?}",
                case.name,
                result.errors.iter().map(|e| &e.keyword).collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn test_invalid_schemas_from_fixtures() {
        let fixtures = load_fixtures();
        for case in &fixtures.invalid {
            let result = validate_smooai_schema(&case.schema);
            assert!(!result.valid, "Expected invalid but got valid for '{}'", case.name);

            let reported: Vec<&str> = result.errors.iter().map(|e| e.keyword.as_str()).collect();
            for expected in &case.expected_keywords {
                assert!(
                    reported.contains(&expected.as_str()),
                    "Expected keyword '{}' in errors for '{}', got {:?}",
                    expected,
                    case.name,
                    reported
                );
            }
        }
    }

    #[test]
    fn test_error_structure() {
        let schema = json!({
            "type": "object",
            "properties": {
                "value": { "not": { "type": "string" } }
            }
        });
        let result = validate_smooai_schema(&schema);
        assert!(!result.valid);
        assert_eq!(result.errors.len(), 1);
        let error = &result.errors[0];
        assert_eq!(error.path, "/properties/value");
        assert_eq!(error.keyword, "not");
        assert!(error.message.contains("not"));
        assert!(!error.suggestion.is_empty());
    }

    #[test]
    fn test_unsupported_format() {
        let schema = json!({
            "type": "object",
            "properties": {
                "field": { "type": "string", "format": "hostname" }
            }
        });
        let result = validate_smooai_schema(&schema);
        assert!(!result.valid);
        assert_eq!(result.errors[0].keyword, "format");
        assert!(result.errors[0].message.contains("hostname"));
    }

    #[test]
    fn test_empty_schema() {
        let result = validate_smooai_schema(&json!({}));
        assert!(result.valid);
    }
}
