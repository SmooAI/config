//! Full pipeline integration tests mirroring TypeScript integration test suite 2.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::Path;

use serde_json::json;
use smooai_config::LocalConfigManager;

fn make_config_dir(dir: &Path) -> String {
    let config_dir = dir.join(".smooai-config");
    fs::create_dir_all(&config_dir).unwrap();

    let files = vec![
        (
            "default.json",
            json!({
                "API_URL": "http://localhost:3000",
                "MAX_RETRIES": 3,
                "ENABLE_DEBUG": true,
                "APP_NAME": "default-app",
                "DATABASE": {"host": "localhost", "port": 5432, "ssl": false},
                "API_KEY": "default-api-key",
                "DB_PASSWORD": "default-db-pass",
                "JWT_SECRET": "default-jwt-secret",
                "ENABLE_NEW_UI": false,
                "ENABLE_BETA": false,
                "MAINTENANCE_MODE": false
            }),
        ),
        (
            "development.json",
            json!({
                "API_URL": "http://dev-api.example.com",
                "ENABLE_DEBUG": true,
                "APP_NAME": "dev-app",
                "ENABLE_NEW_UI": true,
                "ENABLE_BETA": true
            }),
        ),
        (
            "production.json",
            json!({
                "API_URL": "https://api.example.com",
                "MAX_RETRIES": 5,
                "ENABLE_DEBUG": false,
                "APP_NAME": "prod-app",
                "DATABASE": {"host": "prod-db.example.com", "port": 5432, "ssl": true},
                "API_KEY": "prod-api-key-secret",
                "DB_PASSWORD": "prod-db-pass-secret",
                "JWT_SECRET": "prod-jwt-secret",
                "ENABLE_NEW_UI": false,
                "ENABLE_BETA": false,
                "MAINTENANCE_MODE": false
            }),
        ),
        (
            "production.aws.json",
            json!({
                "API_URL": "https://aws-api.example.com",
                "DATABASE": {"host": "aws-prod-db.example.com"}
            }),
        ),
        (
            "production.aws.us-east-1.json",
            json!({
                "DATABASE": {"host": "us-east-1-db.example.com"}
            }),
        ),
    ];

    for (name, content) in files {
        let mut f = fs::File::create(config_dir.join(name)).unwrap();
        f.write_all(serde_json::to_string(&content).unwrap().as_bytes())
            .unwrap();
    }

    config_dir.to_string_lossy().to_string()
}

fn make_env(config_dir: &str, extra: &[(&str, &str)]) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = extra.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    env.insert("SMOOAI_ENV_CONFIG_DIR".to_string(), config_dir.to_string());
    env
}

// --- Default config loading ---

#[test]
fn test_default_loads_all_tiers() {
    let dir = tempfile::tempdir().unwrap();
    let config_dir = make_config_dir(dir.path());
    let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test")]);
    let mgr = LocalConfigManager::new().with_env(env);

    // Public config
    assert_eq!(
        mgr.get_public_config("API_URL").unwrap(),
        Some(json!("http://localhost:3000"))
    );
    assert_eq!(mgr.get_public_config("MAX_RETRIES").unwrap(), Some(json!(3)));
    assert_eq!(mgr.get_public_config("ENABLE_DEBUG").unwrap(), Some(json!(true)));
    assert_eq!(mgr.get_public_config("APP_NAME").unwrap(), Some(json!("default-app")));
    assert_eq!(
        mgr.get_public_config("DATABASE").unwrap(),
        Some(json!({"host": "localhost", "port": 5432, "ssl": false}))
    );

    // Secret config
    assert_eq!(
        mgr.get_secret_config("API_KEY").unwrap(),
        Some(json!("default-api-key"))
    );
    assert_eq!(
        mgr.get_secret_config("DB_PASSWORD").unwrap(),
        Some(json!("default-db-pass"))
    );

    // Feature flags
    assert_eq!(mgr.get_feature_flag("ENABLE_NEW_UI").unwrap(), Some(json!(false)));
    assert_eq!(mgr.get_feature_flag("ENABLE_BETA").unwrap(), Some(json!(false)));
    assert_eq!(mgr.get_feature_flag("MAINTENANCE_MODE").unwrap(), Some(json!(false)));
}

#[test]
fn test_default_builtin_config() {
    let dir = tempfile::tempdir().unwrap();
    let config_dir = make_config_dir(dir.path());
    let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test")]);
    let mgr = LocalConfigManager::new().with_env(env);

    assert_eq!(mgr.get_public_config("ENV").unwrap(), Some(json!("test")));
    assert_eq!(mgr.get_public_config("IS_LOCAL").unwrap(), Some(json!(false)));
    assert_eq!(mgr.get_public_config("CLOUD_PROVIDER").unwrap(), Some(json!("unknown")));
    assert_eq!(mgr.get_public_config("REGION").unwrap(), Some(json!("unknown")));
}

#[test]
fn test_default_nonexistent_key() {
    let dir = tempfile::tempdir().unwrap();
    let config_dir = make_config_dir(dir.path());
    let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test")]);
    let mgr = LocalConfigManager::new().with_env(env);

    assert_eq!(mgr.get_public_config("nonexistent").unwrap(), None);
}

// --- Development merge ---

#[test]
fn test_development_overrides_and_inherits() {
    let dir = tempfile::tempdir().unwrap();
    let config_dir = make_config_dir(dir.path());
    let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "development")]);
    let mgr = LocalConfigManager::new().with_env(env);

    // Overridden
    assert_eq!(
        mgr.get_public_config("API_URL").unwrap(),
        Some(json!("http://dev-api.example.com"))
    );
    assert_eq!(mgr.get_public_config("APP_NAME").unwrap(), Some(json!("dev-app")));
    assert_eq!(mgr.get_public_config("ENABLE_DEBUG").unwrap(), Some(json!(true)));

    // Inherited
    assert_eq!(mgr.get_public_config("MAX_RETRIES").unwrap(), Some(json!(3)));
    assert_eq!(
        mgr.get_public_config("DATABASE").unwrap(),
        Some(json!({"host": "localhost", "port": 5432, "ssl": false}))
    );
}

#[test]
fn test_development_feature_flags() {
    let dir = tempfile::tempdir().unwrap();
    let config_dir = make_config_dir(dir.path());
    let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "development")]);
    let mgr = LocalConfigManager::new().with_env(env);

    assert_eq!(mgr.get_feature_flag("ENABLE_NEW_UI").unwrap(), Some(json!(true)));
    assert_eq!(mgr.get_feature_flag("ENABLE_BETA").unwrap(), Some(json!(true)));
    assert_eq!(mgr.get_feature_flag("MAINTENANCE_MODE").unwrap(), Some(json!(false)));
}

#[test]
fn test_development_inherits_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let config_dir = make_config_dir(dir.path());
    let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "development")]);
    let mgr = LocalConfigManager::new().with_env(env);

    assert_eq!(
        mgr.get_secret_config("API_KEY").unwrap(),
        Some(json!("default-api-key"))
    );
    assert_eq!(
        mgr.get_secret_config("DB_PASSWORD").unwrap(),
        Some(json!("default-db-pass"))
    );
}

// --- Production merge chain ---

#[test]
fn test_production_merge_chain() {
    let dir = tempfile::tempdir().unwrap();
    let config_dir = make_config_dir(dir.path());
    let env = make_env(
        &config_dir,
        &[("SMOOAI_CONFIG_ENV", "production"), ("AWS_REGION", "us-east-1")],
    );
    let mgr = LocalConfigManager::new().with_env(env);

    // production.aws.json overrides API_URL
    assert_eq!(
        mgr.get_public_config("API_URL").unwrap(),
        Some(json!("https://aws-api.example.com"))
    );

    // production.json sets MAX_RETRIES=5
    assert_eq!(mgr.get_public_config("MAX_RETRIES").unwrap(), Some(json!(5)));

    // Deep merge: us-east-1 overrides host, preserves port/ssl
    let db = mgr.get_public_config("DATABASE").unwrap().unwrap();
    assert_eq!(db["host"], json!("us-east-1-db.example.com"));
    assert_eq!(db["ssl"], json!(true));
    assert_eq!(db["port"], json!(5432));
}

#[test]
fn test_production_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let config_dir = make_config_dir(dir.path());
    let env = make_env(
        &config_dir,
        &[("SMOOAI_CONFIG_ENV", "production"), ("AWS_REGION", "us-east-1")],
    );
    let mgr = LocalConfigManager::new().with_env(env);

    assert_eq!(
        mgr.get_secret_config("API_KEY").unwrap(),
        Some(json!("prod-api-key-secret"))
    );
    assert_eq!(
        mgr.get_secret_config("DB_PASSWORD").unwrap(),
        Some(json!("prod-db-pass-secret"))
    );
    assert_eq!(
        mgr.get_secret_config("JWT_SECRET").unwrap(),
        Some(json!("prod-jwt-secret"))
    );
}

#[test]
fn test_production_cloud_detection() {
    let dir = tempfile::tempdir().unwrap();
    let config_dir = make_config_dir(dir.path());
    let env = make_env(
        &config_dir,
        &[("SMOOAI_CONFIG_ENV", "production"), ("AWS_REGION", "us-east-1")],
    );
    let mgr = LocalConfigManager::new().with_env(env);

    assert_eq!(mgr.get_public_config("CLOUD_PROVIDER").unwrap(), Some(json!("aws")));
    assert_eq!(mgr.get_public_config("REGION").unwrap(), Some(json!("us-east-1")));
}

#[test]
fn test_production_enable_debug_false() {
    let dir = tempfile::tempdir().unwrap();
    let config_dir = make_config_dir(dir.path());
    let env = make_env(
        &config_dir,
        &[("SMOOAI_CONFIG_ENV", "production"), ("AWS_REGION", "us-east-1")],
    );
    let mgr = LocalConfigManager::new().with_env(env);

    assert_eq!(mgr.get_public_config("ENABLE_DEBUG").unwrap(), Some(json!(false)));
}

// --- Consistent results ---

#[test]
fn test_consistent_repeated_calls() {
    let dir = tempfile::tempdir().unwrap();
    let config_dir = make_config_dir(dir.path());
    let env = make_env(&config_dir, &[("SMOOAI_CONFIG_ENV", "test")]);
    let mgr = LocalConfigManager::new().with_env(env);

    let r1 = mgr.get_public_config("API_URL").unwrap();
    let r2 = mgr.get_public_config("API_URL").unwrap();
    let r3 = mgr.get_public_config("API_URL").unwrap();
    assert_eq!(r1, r2);
    assert_eq!(r2, r3);
    assert_eq!(r1, Some(json!("http://localhost:3000")));
}
