//! Deferred (computed) config value resolution.
//!
//! Deferred values are closures that receive the full merged config map
//! and return a computed value. All deferred values see the pre-resolution
//! snapshot (not each other's resolved values), ensuring deterministic results.

use std::collections::HashMap;

use serde_json::Value;

/// A deferred config value — a closure that computes a value from the merged config.
pub type DeferredValue = Box<dyn Fn(&HashMap<String, Value>) -> Value + Send + Sync>;

/// Resolve all deferred values against a snapshot of the merged config.
///
/// Takes the merged config map and a map of deferred closures. Each closure
/// receives the pre-resolution snapshot and its return value replaces the
/// corresponding key in the output.
pub fn resolve_deferred(config: &mut HashMap<String, Value>, deferred: &HashMap<String, DeferredValue>) {
    // Take a snapshot for resolution (pre-resolution values only)
    let snapshot: HashMap<String, Value> = config.clone();

    // Resolve each deferred value
    for (key, resolver) in deferred {
        let resolved = resolver(&snapshot);
        config.insert(key.clone(), resolved);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_resolve_basic_deferred() {
        let mut config: HashMap<String, Value> = HashMap::new();
        config.insert("HOST".to_string(), json!("localhost"));
        config.insert("PORT".to_string(), json!(5432));

        let mut deferred: HashMap<String, DeferredValue> = HashMap::new();
        deferred.insert(
            "FULL_URL".to_string(),
            Box::new(|config| {
                let host = config["HOST"].as_str().unwrap_or("unknown");
                let port = config["PORT"].as_u64().unwrap_or(0);
                json!(format!("{}:{}", host, port))
            }),
        );

        resolve_deferred(&mut config, &deferred);

        assert_eq!(config["FULL_URL"], json!("localhost:5432"));
        // Original values should still be present
        assert_eq!(config["HOST"], json!("localhost"));
        assert_eq!(config["PORT"], json!(5432));
    }

    #[test]
    fn test_multiple_deferred_see_snapshot() {
        let mut config: HashMap<String, Value> = HashMap::new();
        config.insert("BASE".to_string(), json!("hello"));

        let mut deferred: HashMap<String, DeferredValue> = HashMap::new();
        deferred.insert(
            "A".to_string(),
            Box::new(|config| {
                let base = config["BASE"].as_str().unwrap_or("");
                json!(format!("{}-a", base))
            }),
        );
        deferred.insert(
            "B".to_string(),
            Box::new(|config| {
                // B should NOT see A's resolved value — it sees the snapshot
                let has_a = config.contains_key("A");
                json!(has_a)
            }),
        );

        resolve_deferred(&mut config, &deferred);

        assert_eq!(config["A"], json!("hello-a"));
        // B should see that "A" was NOT in the snapshot (it wasn't set before deferred resolution)
        assert_eq!(config["B"], json!(false));
    }

    #[test]
    fn test_deferred_after_merge() {
        let mut config: HashMap<String, Value> = HashMap::new();
        config.insert("ENV".to_string(), json!("production"));
        config.insert("HOST".to_string(), json!("prod.example.com"));

        let mut deferred: HashMap<String, DeferredValue> = HashMap::new();
        deferred.insert(
            "API_URL".to_string(),
            Box::new(|config| {
                let host = config["HOST"].as_str().unwrap_or("localhost");
                let env = config["ENV"].as_str().unwrap_or("dev");
                json!(format!("https://{}/api/{}", host, env))
            }),
        );

        resolve_deferred(&mut config, &deferred);

        assert_eq!(config["API_URL"], json!("https://prod.example.com/api/production"));
    }

    #[test]
    fn test_empty_deferred() {
        let mut config: HashMap<String, Value> = HashMap::new();
        config.insert("KEY".to_string(), json!("value"));

        let deferred: HashMap<String, DeferredValue> = HashMap::new();
        resolve_deferred(&mut config, &deferred);

        assert_eq!(config["KEY"], json!("value"));
    }
}
