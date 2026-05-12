//! Smoo AI Configuration Management Library - Rust SDK.
//!
//! Provides schema definition, JSON Schema generation, runtime config client,
//! and local file/env-based configuration with caching.

pub mod bootstrap;
pub mod build;
pub mod client;
pub mod cloud_region;
pub mod config_manager;
pub mod deferred;
pub mod env_config;
pub mod file_config;
pub mod local;
pub mod merge;
pub mod runtime;
pub mod schema;
pub mod schema_validator;
pub mod utils;

pub use bootstrap::{bootstrap_fetch, BootstrapError};
pub use build::{build_bundle, BuildBundleOptions, BuildBundleResult, BuildError, Classification, Classifier};
pub use client::{ConfigClient, EvaluateFeatureFlagResponse, FeatureFlagEvaluationError};
pub use cloud_region::{get_cloud_region, get_cloud_region_from_env, CloudRegionResult};
pub use config_manager::ConfigManager;
pub use env_config::find_and_process_env_config;
pub use file_config::{find_and_process_file_config, find_config_directory};
pub use local::LocalConfigManager;
pub use merge::merge_replace_arrays;
pub use runtime::{build_config_runtime, read_baked_config, BakedConfig, RuntimeError, RuntimeOptions};
pub use utils::{camel_to_upper_snake, coerce_boolean, SmooaiConfigError, SmooaiConfigErrorKind};
