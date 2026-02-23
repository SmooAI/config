//! Utility functions for configuration management.

use std::fmt;

/// Configuration error with standard prefix.
#[derive(Debug, Clone)]
pub struct SmooaiConfigError {
    pub message: String,
}

impl SmooaiConfigError {
    pub fn new(message: &str) -> Self {
        Self {
            message: format!("[Smooai Config] {}", message),
        }
    }
}

impl fmt::Display for SmooaiConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for SmooaiConfigError {}

/// Check if a string is already in UPPER_SNAKE_CASE format.
/// Pattern: ^[A-Z0-9]+(_[A-Z0-9]+)*$
fn is_upper_snake_case(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    let bytes = s.as_bytes();
    if bytes[0] == b'_' || bytes[bytes.len() - 1] == b'_' {
        return false;
    }
    let mut prev_underscore = false;
    for &b in bytes {
        if b == b'_' {
            if prev_underscore {
                return false;
            }
            prev_underscore = true;
            continue;
        }
        prev_underscore = false;
        if !b.is_ascii_uppercase() && !b.is_ascii_digit() {
            return false;
        }
    }
    true
}

/// Convert camelCase to UPPER_SNAKE_CASE.
///
/// One-pass conversion:
/// - Early exit if already UPPER_SNAKE_CASE
/// - Drops underscores/spaces
/// - Splits on lower→Upper and Acronym→Word boundaries
pub fn camel_to_upper_snake(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }
    if is_upper_snake_case(input) {
        return input.to_string();
    }

    let chars: Vec<char> = input.chars().collect();
    let len = chars.len();
    let mut out = String::with_capacity(len + 4);

    for i in 0..len {
        let ch = chars[i];

        // Skip underscores and spaces
        if ch == '_' || ch == ' ' {
            continue;
        }

        if ch.is_uppercase() {
            if i > 0 {
                let prev = chars[i - 1];
                let prev_is_lower = prev.is_lowercase();
                let next_is_lower = if i + 1 < len {
                    chars[i + 1].is_lowercase()
                } else {
                    false
                };
                if prev_is_lower || next_is_lower {
                    out.push('_');
                }
            }
            out.push(ch);
        } else if ch.is_lowercase() {
            out.push(ch.to_uppercase().next().unwrap());
        } else {
            // digits and other chars
            out.push(ch);
        }
    }

    out
}

/// Coerce a string value to boolean.
/// "true", "1" → true; everything else → false.
pub fn coerce_boolean(value: &str) -> bool {
    let lower = value.trim().to_lowercase();
    lower == "true" || lower == "1"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_api_url() {
        assert_eq!(camel_to_upper_snake("apiUrl"), "API_URL");
    }

    #[test]
    fn test_max_retries() {
        assert_eq!(camel_to_upper_snake("maxRetries"), "MAX_RETRIES");
    }

    #[test]
    fn test_enable_debug() {
        assert_eq!(camel_to_upper_snake("enableDebug"), "ENABLE_DEBUG");
    }

    #[test]
    fn test_app_name() {
        assert_eq!(camel_to_upper_snake("appName"), "APP_NAME");
    }

    #[test]
    fn test_database() {
        assert_eq!(camel_to_upper_snake("database"), "DATABASE");
    }

    #[test]
    fn test_api_key() {
        assert_eq!(camel_to_upper_snake("apiKey"), "API_KEY");
    }

    #[test]
    fn test_db_password() {
        assert_eq!(camel_to_upper_snake("dbPassword"), "DB_PASSWORD");
    }

    #[test]
    fn test_jwt_secret() {
        assert_eq!(camel_to_upper_snake("jwtSecret"), "JWT_SECRET");
    }

    #[test]
    fn test_enable_new_ui() {
        assert_eq!(camel_to_upper_snake("enableNewUI"), "ENABLE_NEW_UI");
    }

    #[test]
    fn test_enable_beta() {
        assert_eq!(camel_to_upper_snake("enableBeta"), "ENABLE_BETA");
    }

    #[test]
    fn test_maintenance_mode() {
        assert_eq!(camel_to_upper_snake("maintenanceMode"), "MAINTENANCE_MODE");
    }

    #[test]
    fn test_already_upper_snake_case() {
        assert_eq!(camel_to_upper_snake("API_URL"), "API_URL");
        assert_eq!(camel_to_upper_snake("MAX_RETRIES"), "MAX_RETRIES");
        assert_eq!(camel_to_upper_snake("DATABASE"), "DATABASE");
    }

    #[test]
    fn test_acronym_handling() {
        assert_eq!(camel_to_upper_snake("apiURL"), "API_URL");
    }

    #[test]
    fn test_empty_string() {
        assert_eq!(camel_to_upper_snake(""), "");
    }

    #[test]
    fn test_single_char() {
        assert_eq!(camel_to_upper_snake("a"), "A");
        assert_eq!(camel_to_upper_snake("A"), "A");
    }

    #[test]
    fn test_coerce_boolean_true() {
        assert!(coerce_boolean("true"));
        assert!(coerce_boolean("TRUE"));
        assert!(coerce_boolean("True"));
        assert!(coerce_boolean("1"));
    }

    #[test]
    fn test_coerce_boolean_false() {
        assert!(!coerce_boolean("false"));
        assert!(!coerce_boolean("0"));
        assert!(!coerce_boolean(""));
        assert!(!coerce_boolean("yes"));
    }

    #[test]
    fn test_error_message_format() {
        let err = SmooaiConfigError::new("test error");
        assert_eq!(err.to_string(), "[Smooai Config] test error");
    }
}
