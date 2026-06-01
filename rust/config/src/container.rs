//! Container / runtime mode for `smooai-config` (SMOODEV-1494).
//!
//! Rust parity with the TypeScript reference implementation
//! (`src/container/`, SMOODEV-1490) and the five-language contract in
//! [`docs/Container-Runtime-Mode-Spec.md`]. Idioms differ; behavior does not.
//!
//! # Why
//!
//! `smooai-config` resolves values through four tiers: **blob → env → http →
//! file**. The blob tier (an encrypted bundle baked into a Lambda layer / image
//! at deploy time, decrypted with a separately-delivered key) is the blessed
//! path for **Lambda**. It is the *wrong* default for long-lived **containers**
//! (EKS/ECS): when the per-build blob key isn't delivered to the pod,
//! resolution silently falls through to the (absent) file tier and returns an
//! absent value for a required secret (the SMOODEV-1478 CrashLoop outage).
//!
//! Container mode makes the **HTTP tier the blessed, first-class path** for
//! containers, authenticated with an OAuth2 `client_credentials` (M2M) token,
//! and **fail-loud** so a missing required value is an immediate, typed error
//! ([`ConfigKeyUnresolvedError`]) — never a silent absent value.
//!
//! # Usage
//!
//! ```no_run
//! use smooai_config::container::{init_container_config, InitContainerConfigOptions};
//! use smooai_config::schema::define_config;
//!
//! # async fn run() -> Result<(), Box<dyn std::error::Error>> {
//! let schema = define_config(None, None, None);
//! // Validates env, mints a token, does an initial fetch — startup fails
//! // loudly here, not on first read.
//! let handle = init_container_config(InitContainerConfigOptions {
//!     schema,
//!     ..Default::default()
//! })
//! .await?;
//!
//! // Fail-loud: a required secret that doesn't resolve returns Err.
//! let stripe_key = handle.secret_config().get("stripeApiKey").await?;
//!
//! // Readiness probe handler:
//! let health = handle.health();
//! # let _ = (stripe_key, health);
//! # Ok(())
//! # }
//! ```
//!
//! # Env contract (§1 — identical across all five SDKs)
//!
//! ```text
//! SMOOAI_CONFIG_MODE          `container` forces this mode (see select_mode).
//! SMOOAI_CONFIG_API_URL       (required) config API base URL.
//! SMOOAI_CONFIG_AUTH_URL      OAuth issuer base URL (default https://auth.smoo.ai).
//! SMOOAI_CONFIG_CLIENT_ID     (required) M2M OAuth client id.
//! SMOOAI_CONFIG_CLIENT_SECRET (required) M2M OAuth client secret
//!                             (legacy alias SMOOAI_CONFIG_API_KEY accepted).
//! SMOOAI_CONFIG_ORG_ID        (required) org id whose config to fetch.
//! SMOOAI_CONFIG_ENV           (required) environment name (e.g. production).
//! ```

use std::collections::HashSet;
use std::env;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::Mutex;

use crate::client::ConfigClient;
use crate::schema::ConfigDefinition;
use crate::token_provider::TokenProvider;
use crate::utils::camel_to_upper_snake;

/// Default config-value cache TTL (§5). Same 30s default in every SDK.
pub const DEFAULT_CACHE_TTL: Duration = Duration::from_secs(30);

/// Default token proactive-refresh window in seconds (§5).
pub const DEFAULT_TOKEN_REFRESH_BUFFER_SECONDS: u64 = 60;

// ---------------------------------------------------------------------------
// Resolution tiers
// ---------------------------------------------------------------------------

/// One of the resolution tiers consulted during a value read.
///
/// In container mode only [`Env`](ConfigTier::Env) and [`Http`](ConfigTier::Http)
/// are active; [`Blob`](ConfigTier::Blob) and [`File`](ConfigTier::File) exist
/// for parity with the full tier chain and are reported in error context.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigTier {
    /// The baked-blob tier (Lambda path; disabled in container mode).
    Blob,
    /// The process-environment override tier.
    Env,
    /// The HTTP config-server tier (the blessed container path).
    Http,
    /// The local `.smooai-config/` file tier (disabled in container mode).
    File,
}

impl ConfigTier {
    /// The lowercase wire name (`"blob" | "env" | "http" | "file"`) — matches
    /// the TS `ConfigTier` string union carried by [`ConfigKeyUnresolvedError`].
    pub fn as_str(self) -> &'static str {
        match self {
            ConfigTier::Blob => "blob",
            ConfigTier::Env => "env",
            ConfigTier::Http => "http",
            ConfigTier::File => "file",
        }
    }
}

impl fmt::Display for ConfigTier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

// ---------------------------------------------------------------------------
// Typed errors (parity with TS errors.ts — same names, same carried fields)
// ---------------------------------------------------------------------------

/// Returned by [`init_container_config`] when the container-required
/// environment (§1) is missing or blank. Carries the exact list of offending
/// env var names so the operator can fix the deployment without guessing.
/// No partial init: if any required var is absent, bootstrap fails whole.
///
/// Parity: TS `ConfigBootstrapError { missing: string[] }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigBootstrapError {
    /// Env var names (e.g. `SMOOAI_CONFIG_CLIENT_ID`) that are missing or blank.
    pub missing: Vec<String>,
}

impl fmt::Display for ConfigBootstrapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let vars = if self.missing.len() == 1 {
            "this variable"
        } else {
            "these variables"
        };
        write!(
            f,
            "[smooai-config] container-mode bootstrap failed: missing required env {}. \
             Set {} before calling init_container_config() \
             (see docs/Container-Runtime-Mode.md for the Kubernetes/ExternalSecret recipe).",
            self.missing.join(", "),
            vars,
        )
    }
}

impl std::error::Error for ConfigBootstrapError {}

/// Returned by a required-key read ([`SecretConfigAccessor::get`] / `get_sync`
/// and the public/flag analogs) in container mode when the value resolves to
/// absent across every active tier. This is the exact class that closes the
/// silent-absent-value hole (SMOODEV-1478 / SMOODEV-1135).
///
/// Optional keys (declared via [`InitContainerConfigOptions::optional_keys`])
/// do NOT produce this — they resolve to `Ok(None)`.
///
/// Parity: TS `ConfigKeyUnresolvedError { key, env, triedTiers }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigKeyUnresolvedError {
    /// The camelCase config key that could not be resolved.
    pub key: String,
    /// The environment the read targeted (e.g. `production`).
    pub env: String,
    /// The tiers that were consulted, in order, before giving up
    /// (container mode tries `["env", "http"]`).
    pub tried_tiers: Vec<ConfigTier>,
}

impl fmt::Display for ConfigKeyUnresolvedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let tiers: Vec<&str> = self.tried_tiers.iter().map(|t| t.as_str()).collect();
        let tiers = if tiers.is_empty() {
            "none".to_string()
        } else {
            tiers.join(" → ")
        };
        write!(
            f,
            "[smooai-config] required config key \"{}\" did not resolve in environment \"{}\" \
             (container mode; tiers tried: {}). \
             Set a value for this key in the config server for \"{}\", or mark it optional via \
             init_container_config(optional_keys: [\"{}\"]).",
            self.key, self.env, tiers, self.env, self.key,
        )
    }
}

impl std::error::Error for ConfigKeyUnresolvedError {}

/// Unified error type for container mode. Carries the [`ConfigBootstrapError`]
/// and [`ConfigKeyUnresolvedError`] variants with their exact fields, plus
/// auth/network failures surfaced during the initial fetch or a value read.
#[derive(Debug)]
pub enum ConfigError {
    /// Container-required env was missing or blank at bootstrap.
    Bootstrap(ConfigBootstrapError),
    /// A required key did not resolve across the active tiers.
    KeyUnresolved(ConfigKeyUnresolvedError),
    /// The initial token mint / config fetch failed, or a request errored.
    /// Carries the underlying message (auth, network, non-2xx status).
    Fetch(String),
}

impl ConfigError {
    /// Convenience constructor for a [`ConfigError::KeyUnresolved`].
    pub fn key_unresolved(key: impl Into<String>, env: impl Into<String>, tried_tiers: Vec<ConfigTier>) -> Self {
        ConfigError::KeyUnresolved(ConfigKeyUnresolvedError {
            key: key.into(),
            env: env.into(),
            tried_tiers,
        })
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigError::Bootstrap(e) => fmt::Display::fmt(e, f),
            ConfigError::KeyUnresolved(e) => fmt::Display::fmt(e, f),
            ConfigError::Fetch(msg) => write!(f, "[smooai-config] container config fetch failed: {msg}"),
        }
    }
}

impl std::error::Error for ConfigError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            ConfigError::Bootstrap(e) => Some(e),
            ConfigError::KeyUnresolved(e) => Some(e),
            ConfigError::Fetch(_) => None,
        }
    }
}

impl From<ConfigBootstrapError> for ConfigError {
    fn from(e: ConfigBootstrapError) -> Self {
        ConfigError::Bootstrap(e)
    }
}

impl From<ConfigKeyUnresolvedError> for ConfigError {
    fn from(e: ConfigKeyUnresolvedError) -> Self {
        ConfigError::KeyUnresolved(e)
    }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/// Status returned by [`ContainerConfigHandle::health`] / [`config_health`].
/// Never produced by a fallible path — the accessors return it directly.
///
/// Parity: TS `{ status: 'healthy' } | { status: 'unhealthy'; reason }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigHealth {
    /// The active config source is usable (initial fetch succeeded; serving
    /// fresh or last-good within the cache TTL).
    Healthy,
    /// The initial fetch never succeeded, or a refresh has been failing past
    /// the TTL hard-expiry.
    Unhealthy {
        /// Human-readable reason for the unhealthy status.
        reason: String,
    },
}

impl ConfigHealth {
    /// The `"healthy" | "unhealthy"` status string (matches the TS shape).
    pub fn status(&self) -> &'static str {
        match self {
            ConfigHealth::Healthy => "healthy",
            ConfigHealth::Unhealthy { .. } => "unhealthy",
        }
    }

    /// Whether the status is [`Healthy`](ConfigHealth::Healthy).
    pub fn is_healthy(&self) -> bool {
        matches!(self, ConfigHealth::Healthy)
    }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/// Options for [`init_container_config`]. Every field mirrors an env var in the
/// §1 contract so tests and embedders can construct a handle without touching
/// the process environment. When a field is `None`, the env var is read.
///
/// `schema` is required so the handle knows which keys exist and can apply the
/// default-required posture (every schema key is required unless listed in
/// `optional_keys`).
#[derive(Default)]
pub struct InitContainerConfigOptions {
    /// The config schema for this service. Required.
    pub schema: ConfigDefinition,
    /// Config API base URL. Falls back to `SMOOAI_CONFIG_API_URL`.
    pub api_url: Option<String>,
    /// OAuth issuer base URL. Falls back to `SMOOAI_CONFIG_AUTH_URL`, then
    /// legacy `SMOOAI_AUTH_URL`, then `https://auth.smoo.ai`.
    pub auth_url: Option<String>,
    /// M2M OAuth client id. Falls back to `SMOOAI_CONFIG_CLIENT_ID`.
    pub client_id: Option<String>,
    /// M2M OAuth client secret. Falls back to `SMOOAI_CONFIG_CLIENT_SECRET`,
    /// then legacy `SMOOAI_CONFIG_API_KEY`.
    pub client_secret: Option<String>,
    /// Org id whose config to fetch. Falls back to `SMOOAI_CONFIG_ORG_ID`.
    pub org_id: Option<String>,
    /// Environment name (e.g. `production`). Falls back to `SMOOAI_CONFIG_ENV`.
    pub environment: Option<String>,
    /// Config value cache TTL. Default [`DEFAULT_CACHE_TTL`] (30s). A background
    /// refresh failure serves the last-good value until this TTL hard-expires,
    /// at which point [`ContainerConfigHandle::health`] reports unhealthy (§5).
    pub cache_ttl: Option<Duration>,
    /// Seconds before token expiry to proactively refresh. Default
    /// [`DEFAULT_TOKEN_REFRESH_BUFFER_SECONDS`] (60s).
    pub token_refresh_buffer_seconds: Option<u64>,
    /// Keys allowed to be absent. A read of any of these returns `Ok(None)`
    /// instead of a [`ConfigError::KeyUnresolved`]. Everything else declared in
    /// `schema` is required (container mode's default-required posture).
    pub optional_keys: Vec<String>,
    /// Test/embedding seam — inject a pre-built [`ConfigClient`]. When supplied,
    /// `api_url`/`auth_url`/`client_id`/`client_secret`/`org_id` env validation
    /// is skipped (the client carries them) but `environment` is still required.
    pub config_client: Option<ConfigClient>,
}

// ---------------------------------------------------------------------------
// Env resolution / bootstrap validation
// ---------------------------------------------------------------------------

/// Blank-aware presence: a set-but-whitespace value counts as missing.
fn non_blank(v: Option<String>) -> Option<String> {
    v.and_then(|s| if s.trim().is_empty() { None } else { Some(s) })
}

fn env_var(name: &str) -> Option<String> {
    non_blank(env::var(name).ok())
}

struct ResolvedContainerEnv {
    api_url: String,
    auth_url: String,
    client_id: String,
    client_secret: String,
    org_id: String,
    environment: String,
}

/// Resolve and validate the container-mode env contract (§1). Returns the
/// resolved values, or [`ConfigBootstrapError`] listing exactly which required
/// vars are missing/blank. No partial result.
fn resolve_and_validate_env(
    options: &InitContainerConfigOptions,
) -> Result<ResolvedContainerEnv, ConfigBootstrapError> {
    let api_url = non_blank(options.api_url.clone()).or_else(|| env_var("SMOOAI_CONFIG_API_URL"));
    let auth_url = non_blank(options.auth_url.clone())
        .or_else(|| env_var("SMOOAI_CONFIG_AUTH_URL"))
        .or_else(|| env_var("SMOOAI_AUTH_URL"))
        .unwrap_or_else(|| "https://auth.smoo.ai".to_string());
    let client_id = non_blank(options.client_id.clone()).or_else(|| env_var("SMOOAI_CONFIG_CLIENT_ID"));
    let client_secret = non_blank(options.client_secret.clone())
        .or_else(|| env_var("SMOOAI_CONFIG_CLIENT_SECRET"))
        .or_else(|| env_var("SMOOAI_CONFIG_API_KEY"));
    let org_id = non_blank(options.org_id.clone()).or_else(|| env_var("SMOOAI_CONFIG_ORG_ID"));
    let environment = non_blank(options.environment.clone()).or_else(|| env_var("SMOOAI_CONFIG_ENV"));

    // When a ConfigClient is injected it already carries api_url/auth/client_id/
    // secret/org_id — only the environment is still container-required.
    let client_injected = options.config_client.is_some();

    let mut missing: Vec<String> = Vec::new();
    if !client_injected {
        if api_url.is_none() {
            missing.push("SMOOAI_CONFIG_API_URL".to_string());
        }
        if client_id.is_none() {
            missing.push("SMOOAI_CONFIG_CLIENT_ID".to_string());
        }
        if client_secret.is_none() {
            missing.push("SMOOAI_CONFIG_CLIENT_SECRET".to_string());
        }
        if org_id.is_none() {
            missing.push("SMOOAI_CONFIG_ORG_ID".to_string());
        }
    }
    if environment.is_none() {
        missing.push("SMOOAI_CONFIG_ENV".to_string());
    }

    if !missing.is_empty() {
        return Err(ConfigBootstrapError { missing });
    }

    Ok(ResolvedContainerEnv {
        api_url: api_url.unwrap_or_default(),
        auth_url,
        client_id: client_id.unwrap_or_default(),
        client_secret: client_secret.unwrap_or_default(),
        org_id: org_id.unwrap_or_default(),
        environment: environment.expect("environment validated present"),
    })
}

// ---------------------------------------------------------------------------
// Health state (§5)
// ---------------------------------------------------------------------------

struct HealthState {
    last_fetch_ok: bool,
    last_fetch_at: Option<Instant>,
    last_error: Option<String>,
}

/// A TTL-bounded entry in the sync cache mirror.
struct SyncCacheEntry {
    value: Value,
    expires_at: Option<Instant>,
}

// ---------------------------------------------------------------------------
// Shared inner state
// ---------------------------------------------------------------------------

struct Inner {
    /// The HTTP config client. `get_value`/`get_all_values` take `&mut self`
    /// (they mutate the cache), so the client is behind an async mutex.
    client: Mutex<ConfigClient>,
    /// Synchronous cache mirror for `get_sync` (avoids blocking on the async
    /// mutex from a sync context). Seeded by the initial fetch and updated on
    /// each async resolve. Entries carry the same TTL expiry as the underlying
    /// client cache so a sync read can't serve a value past hard-expiry.
    sync_cache: RwLock<std::collections::HashMap<String, SyncCacheEntry>>,
    environment: String,
    cache_ttl: Duration,
    optional_keys: HashSet<String>,
    health: std::sync::Mutex<HealthState>,
}

impl Inner {
    fn is_optional(&self, key: &str) -> bool {
        self.optional_keys.contains(key)
    }

    fn record_ok(&self) {
        let mut h = self.health.lock().expect("health mutex");
        h.last_fetch_ok = true;
        h.last_fetch_at = Some(Instant::now());
        h.last_error = None;
    }

    fn record_err(&self, msg: String) {
        let mut h = self.health.lock().expect("health mutex");
        h.last_error = Some(msg);
    }

    fn health(&self) -> ConfigHealth {
        let h = self.health.lock().expect("health mutex");
        if !h.last_fetch_ok {
            return ConfigHealth::Unhealthy {
                reason: h
                    .last_error
                    .clone()
                    .unwrap_or_else(|| "initial config fetch has not succeeded".to_string()),
            };
        }
        if let (Some(err), Some(at)) = (h.last_error.as_ref(), h.last_fetch_at) {
            // Serve healthy while within the cache TTL of the last good fetch
            // even if a background refresh just failed. Past the hard TTL, a
            // failed refresh flips us unhealthy (§5).
            if at.elapsed() > self.cache_ttl {
                return ConfigHealth::Unhealthy {
                    reason: format!(
                        "last config refresh failed and cache TTL ({:?}) expired: {err}",
                        self.cache_ttl
                    ),
                };
            }
        }
        ConfigHealth::Healthy
    }

    fn sync_cached(&self, key: &str) -> Option<Value> {
        let guard = self.sync_cache.read().expect("sync cache read");
        let entry = guard.get(key)?;
        if let Some(expires_at) = entry.expires_at {
            if Instant::now() > expires_at {
                return None;
            }
        }
        Some(entry.value.clone())
    }

    fn seed_sync(&self, key: &str, value: Value) {
        let expires_at = Some(Instant::now() + self.cache_ttl);
        self.sync_cache
            .write()
            .expect("sync cache write")
            .insert(key.to_string(), SyncCacheEntry { value, expires_at });
    }

    /// Async resolve for a single key. Order matches the existing chain's
    /// env-over-http precedence: an explicitly-set process env var wins, else
    /// the HTTP (config server) value. Blob/file tiers are disabled (§2).
    async fn resolve(&self, key: &str) -> (Option<Value>, Vec<ConfigTier>) {
        let mut tried = vec![ConfigTier::Env];

        // env tier — explicit process override.
        if let Some(from_env) = env_var(&camel_to_upper_snake(key)) {
            let value = Value::String(from_env);
            {
                let mut client = self.client.lock().await;
                client.seed_cache(key, value.clone(), Some(&self.environment));
            }
            self.seed_sync(key, value.clone());
            return (Some(value), tried);
        }

        // http tier — the blessed container path.
        tried.push(ConfigTier::Http);
        let result = {
            let mut client = self.client.lock().await;
            client.get_value(key, Some(&self.environment)).await
        };
        match result {
            Ok(value) => {
                self.record_ok();
                if is_present(&value) {
                    self.seed_sync(key, value.clone());
                    (Some(value), tried)
                } else {
                    (None, tried)
                }
            }
            Err(err) => {
                self.record_err(err.to_string());
                // §5: serve last-good from cache until TTL hard-expiry.
                let cached = {
                    let client = self.client.lock().await;
                    client.get_cached_value(key, Some(&self.environment))
                };
                match cached.filter(is_present) {
                    Some(value) => {
                        self.seed_sync(key, value.clone());
                        (Some(value), tried)
                    }
                    None => (None, tried),
                }
            }
        }
    }

    /// Sync resolve for `get_sync`. Reads the env tier then the sync cache
    /// mirror (which was seeded by the initial fetch + later async resolves).
    fn sync_resolve(&self, key: &str) -> (Option<Value>, Vec<ConfigTier>) {
        let mut tried = vec![ConfigTier::Env];
        if let Some(from_env) = env_var(&camel_to_upper_snake(key)) {
            return (Some(Value::String(from_env)), tried);
        }
        tried.push(ConfigTier::Http);
        (self.sync_cached(key).filter(is_present), tried)
    }

    async fn get(&self, key: &str) -> Result<Option<Value>, ConfigError> {
        let (value, tried) = self.resolve(key).await;
        match value {
            Some(v) => Ok(Some(v)),
            None => {
                if self.is_optional(key) {
                    Ok(None)
                } else {
                    Err(ConfigError::key_unresolved(key, &self.environment, tried))
                }
            }
        }
    }

    fn get_sync(&self, key: &str) -> Result<Option<Value>, ConfigError> {
        let (value, tried) = self.sync_resolve(key);
        match value {
            Some(v) => Ok(Some(v)),
            None => {
                if self.is_optional(key) {
                    Ok(None)
                } else {
                    Err(ConfigError::key_unresolved(key, &self.environment, tried))
                }
            }
        }
    }
}

/// A JSON value is "present" unless it's `null`. Empty strings count as present
/// here (the server stores an explicit empty string as a real value); absence
/// is modeled as `null` / missing in the response.
fn is_present(v: &Value) -> bool {
    !v.is_null()
}

// ---------------------------------------------------------------------------
// Handle + tier accessors
// ---------------------------------------------------------------------------

/// The handle returned by [`init_container_config`]. Exposes the three tier
/// accessors ([`Self::secret_config`], [`Self::public_config`],
/// [`Self::feature_flag`]) with §3 fail-loud `get`/`get_sync`, a non-throwing
/// [`Self::health`] for k8s readiness/liveness probes, and the underlying
/// [`Self::client`] (escape hatch).
///
/// Cheap to [`Clone`] — clones share the same underlying client + cache.
#[derive(Clone)]
pub struct ContainerConfigHandle {
    inner: Arc<Inner>,
}

impl fmt::Debug for ContainerConfigHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ContainerConfigHandle")
            .field("environment", &self.inner.environment)
            .field("cache_ttl", &self.inner.cache_ttl)
            .field("health", &self.inner.health())
            .finish_non_exhaustive()
    }
}

impl ContainerConfigHandle {
    /// Secret-tier accessor (fail-loud `get` / `get_sync`).
    pub fn secret_config(&self) -> SecretConfigAccessor<'_> {
        SecretConfigAccessor { inner: &self.inner }
    }

    /// Public-tier accessor (fail-loud `get` / `get_sync`).
    pub fn public_config(&self) -> PublicConfigAccessor<'_> {
        PublicConfigAccessor { inner: &self.inner }
    }

    /// Feature-flag-tier accessor (fail-loud `get` / `get_sync`).
    pub fn feature_flag(&self) -> FeatureFlagAccessor<'_> {
        FeatureFlagAccessor { inner: &self.inner }
    }

    /// Cheap, non-failing status for readiness/liveness probes (§4).
    pub fn health(&self) -> ConfigHealth {
        self.inner.health()
    }

    /// Run a closure with the underlying [`ConfigClient`] (escape hatch for
    /// advanced callers). The client is behind an async mutex; this borrows it
    /// for the duration of the call.
    pub async fn with_client<R>(&self, f: impl FnOnce(&mut ConfigClient) -> R) -> R {
        let mut client = self.inner.client.lock().await;
        f(&mut client)
    }
}

/// Generate the three near-identical tier accessor structs. The resolution
/// chain is identical across tiers in container mode (env → http); the
/// per-tier types exist for API parity with the TS `secretConfig` /
/// `publicConfig` / `featureFlag` split and for call-site readability.
macro_rules! tier_accessor {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        pub struct $name<'a> {
            inner: &'a Inner,
        }

        impl $name<'_> {
            /// Async fail-loud read. A required key that resolves absent returns
            /// [`ConfigError::KeyUnresolved`]; an optional key returns `Ok(None)`.
            pub async fn get(&self, key: &str) -> Result<Option<Value>, ConfigError> {
                self.inner.get(key).await
            }

            /// Sync fail-loud read off the cache mirror. A required key that is
            /// not cached returns [`ConfigError::KeyUnresolved`] (never a silent
            /// absent value); an optional key returns `Ok(None)`.
            pub fn get_sync(&self, key: &str) -> Result<Option<Value>, ConfigError> {
                self.inner.get_sync(key)
            }
        }
    };
}

tier_accessor!(
    /// Secret-tier accessor returned by [`ContainerConfigHandle::secret_config`].
    SecretConfigAccessor
);
tier_accessor!(
    /// Public-tier accessor returned by [`ContainerConfigHandle::public_config`].
    PublicConfigAccessor
);
tier_accessor!(
    /// Feature-flag accessor returned by [`ContainerConfigHandle::feature_flag`].
    FeatureFlagAccessor
);

// ---------------------------------------------------------------------------
// init_container_config
// ---------------------------------------------------------------------------

/// Explicit container-mode bootstrap (§4). Validates the §1 env, constructs the
/// M2M [`TokenProvider`] + [`ConfigClient`], and performs an **initial token
/// mint + config fetch** so auth/network failures surface at startup, not on
/// first read. Returns a [`ContainerConfigHandle`] whose accessors are
/// fail-loud (§3).
///
/// # Errors
/// - [`ConfigError::Bootstrap`] when container-required env is missing/blank.
/// - [`ConfigError::Fetch`] on auth/network failure during the initial fetch.
pub async fn init_container_config(options: InitContainerConfigOptions) -> Result<ContainerConfigHandle, ConfigError> {
    let env = resolve_and_validate_env(&options)?;
    let cache_ttl = options.cache_ttl.unwrap_or(DEFAULT_CACHE_TTL);
    let refresh_buffer = options
        .token_refresh_buffer_seconds
        .unwrap_or(DEFAULT_TOKEN_REFRESH_BUFFER_SECONDS);
    let optional_keys: HashSet<String> = options.optional_keys.iter().cloned().collect();

    // Build the ConfigClient. When the caller injects one (test/embedding seam)
    // it already carries its own TokenProvider, so we don't build a second one
    // (env creds may be empty in that path).
    let mut client = match options.config_client {
        Some(c) => c,
        None => {
            let provider = TokenProvider::with_options(
                &env.auth_url,
                &env.client_id,
                &env.client_secret,
                Duration::from_secs(refresh_buffer),
                reqwest::Client::new(),
            )
            .map_err(|e| ConfigError::Fetch(e.to_string()))?;
            ConfigClient::with_token_provider(&env.api_url, Arc::new(provider), &env.org_id, &env.environment)
        }
    };
    client.set_cache_ttl(Some(cache_ttl));

    // Initial config fetch — fail loud at startup, not first read. The OAuth
    // token mint happens inside get_all_values (the ConfigClient's
    // TokenProvider exchanges on the first authed request), so an auth failure
    // surfaces here too. A pod that can't reach the config server should
    // CrashLoop visibly, not start degraded.
    let initial = client.get_all_values(Some(&env.environment)).await;
    let mut sync_cache = std::collections::HashMap::new();
    let seeded_expires_at = Some(Instant::now() + cache_ttl);
    let health = match initial {
        Ok(values) => {
            for (k, v) in values {
                if is_present(&v) {
                    sync_cache.insert(
                        k,
                        SyncCacheEntry {
                            value: v,
                            expires_at: seeded_expires_at,
                        },
                    );
                }
            }
            HealthState {
                last_fetch_ok: true,
                last_fetch_at: Some(Instant::now()),
                last_error: None,
            }
        }
        Err(err) => {
            return Err(ConfigError::Fetch(err.to_string()));
        }
    };

    // `schema` is accepted for parity + the default-required posture (every
    // schema key is required unless in optional_keys). The Rust SDK does not
    // pre-enumerate schema keys for reads — required-ness is enforced per-read:
    // any key not in optional_keys that resolves absent fails loud. Holding the
    // schema keeps the API symmetric with the other SDKs and reserves room for
    // schema-driven validation without a breaking signature change.
    let _ = &options.schema;

    let inner = Arc::new(Inner {
        client: Mutex::new(client),
        sync_cache: RwLock::new(sync_cache),
        environment: env.environment,
        cache_ttl,
        optional_keys,
        health: std::sync::Mutex::new(health),
    });

    Ok(ContainerConfigHandle { inner })
}

/// Standalone health check (§4) for a handle. Exposed both as
/// [`ContainerConfigHandle::health`] and as this free function for call sites
/// that prefer the functional form. Never fails.
pub fn config_health(handle: &ContainerConfigHandle) -> ConfigHealth {
    handle.health()
}

// ---------------------------------------------------------------------------
// Mode selection (§2)
// ---------------------------------------------------------------------------

/// Mode the SDK should run in, per §2. [`Container`](Mode::Container) means
/// HTTP-primary fail-loud; [`Default`](Mode::Default) means the existing
/// blob → env → http → file chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Container mode (HTTP-primary, fail-loud).
    Container,
    /// Existing default behavior (Lambda blob / local file chain).
    Default,
}

/// Inputs for [`select_mode`]. When a field is `None`, the corresponding env
/// var is read.
#[derive(Default)]
pub struct SelectModeInputs {
    /// `SMOOAI_CONFIG_MODE`.
    pub mode: Option<String>,
    /// `SMOOAI_CONFIG_CLIENT_ID`.
    pub client_id: Option<String>,
    /// `SMOOAI_CONFIG_CLIENT_SECRET` (or legacy `SMOOAI_CONFIG_API_KEY`).
    pub client_secret: Option<String>,
    /// `SMOOAI_CONFIG_API_URL`.
    pub api_url: Option<String>,
    /// Whether a baked blob source is present (`SMOO_CONFIG_KEY` +
    /// `SMOO_CONFIG_KEY_FILE`). When `None`, derived from those env vars.
    pub blob_present: Option<bool>,
    /// Whether a local `.smooai-config/` file source is present. When `None`,
    /// treated as `false`.
    pub file_present: Option<bool>,
}

// Logged once per process when container mode is auto-selected.
static AUTO_SELECT_LOGGED: AtomicBool = AtomicBool::new(false);

/// Mode selection (§2). Resolution order:
///   1. `SMOOAI_CONFIG_MODE=container` → container mode (explicit).
///   2. else if a blob/file source is present → default (Lambda/local).
///   3. else if CLIENT_ID + CLIENT_SECRET + API_URL all set → container (auto;
///      logs once that container mode was auto-selected).
///   4. else → default.
///
/// Container mode MUST NOT silently degrade to the file tier — that decision is
/// enforced by [`init_container_config`]'s bootstrap validation; this only
/// decides which mode to enter.
pub fn select_mode(inputs: Option<SelectModeInputs>) -> Mode {
    let inputs = inputs.unwrap_or_default();

    let mode = non_blank(inputs.mode).or_else(|| env_var("SMOOAI_CONFIG_MODE"));
    if mode
        .as_deref()
        .map(|m| m.eq_ignore_ascii_case("container"))
        .unwrap_or(false)
    {
        return Mode::Container;
    }

    let blob_present = inputs
        .blob_present
        .unwrap_or_else(|| env_var("SMOO_CONFIG_KEY").is_some() && env_var("SMOO_CONFIG_KEY_FILE").is_some());
    let file_present = inputs.file_present.unwrap_or(false);
    if blob_present || file_present {
        return Mode::Default;
    }

    let client_id = non_blank(inputs.client_id).or_else(|| env_var("SMOOAI_CONFIG_CLIENT_ID"));
    let client_secret = non_blank(inputs.client_secret)
        .or_else(|| env_var("SMOOAI_CONFIG_CLIENT_SECRET"))
        .or_else(|| env_var("SMOOAI_CONFIG_API_KEY"));
    let api_url = non_blank(inputs.api_url).or_else(|| env_var("SMOOAI_CONFIG_API_URL"));

    if client_id.is_some() && client_secret.is_some() && api_url.is_some() {
        if !AUTO_SELECT_LOGGED.swap(true, Ordering::Relaxed) {
            eprintln!(
                "[smooai-config] container mode auto-selected \
                 (CLIENT_ID + CLIENT_SECRET + API_URL set, no blob/file source present)"
            );
        }
        return Mode::Container;
    }
    Mode::Default
}

/// Test-only: reset the once-per-process auto-select log latch.
#[doc(hidden)]
pub fn __reset_select_mode_log_for_tests() {
    AUTO_SELECT_LOGGED.store(false, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_blank_treats_whitespace_as_absent() {
        assert_eq!(non_blank(Some("   ".to_string())), None);
        assert_eq!(non_blank(Some("".to_string())), None);
        assert_eq!(non_blank(Some("x".to_string())), Some("x".to_string()));
        assert_eq!(non_blank(None), None);
    }

    #[test]
    fn tier_strings_match_wire_contract() {
        assert_eq!(ConfigTier::Blob.as_str(), "blob");
        assert_eq!(ConfigTier::Env.as_str(), "env");
        assert_eq!(ConfigTier::Http.as_str(), "http");
        assert_eq!(ConfigTier::File.as_str(), "file");
    }

    #[test]
    fn bootstrap_error_message_lists_vars() {
        let e = ConfigBootstrapError {
            missing: vec!["SMOOAI_CONFIG_API_URL".to_string(), "SMOOAI_CONFIG_ENV".to_string()],
        };
        let msg = e.to_string();
        assert!(msg.contains("SMOOAI_CONFIG_API_URL"));
        assert!(msg.contains("SMOOAI_CONFIG_ENV"));
        assert!(msg.contains("these variables"));
    }

    #[test]
    fn bootstrap_error_singular_phrasing() {
        let e = ConfigBootstrapError {
            missing: vec!["SMOOAI_CONFIG_ENV".to_string()],
        };
        assert!(e.to_string().contains("this variable"));
    }

    #[test]
    fn key_unresolved_message_carries_context() {
        let e = ConfigKeyUnresolvedError {
            key: "stripeApiKey".to_string(),
            env: "production".to_string(),
            tried_tiers: vec![ConfigTier::Env, ConfigTier::Http],
        };
        let msg = e.to_string();
        assert!(msg.contains("stripeApiKey"));
        assert!(msg.contains("production"));
        assert!(msg.contains("env → http"));
        assert!(msg.contains("optional"));
    }

    #[test]
    fn config_error_wraps_typed_variants_as_source() {
        let bootstrap: ConfigError = ConfigBootstrapError {
            missing: vec!["SMOOAI_CONFIG_ENV".to_string()],
        }
        .into();
        assert!(std::error::Error::source(&bootstrap).is_some());
        assert!(matches!(bootstrap, ConfigError::Bootstrap(_)));

        let unresolved = ConfigError::key_unresolved("k", "production", vec![ConfigTier::Env, ConfigTier::Http]);
        match &unresolved {
            ConfigError::KeyUnresolved(e) => {
                assert_eq!(e.key, "k");
                assert_eq!(e.tried_tiers, vec![ConfigTier::Env, ConfigTier::Http]);
            }
            other => panic!("expected KeyUnresolved, got {other:?}"),
        }
    }

    #[test]
    fn config_health_status_and_helpers() {
        assert_eq!(ConfigHealth::Healthy.status(), "healthy");
        assert!(ConfigHealth::Healthy.is_healthy());
        let u = ConfigHealth::Unhealthy {
            reason: "x".to_string(),
        };
        assert_eq!(u.status(), "unhealthy");
        assert!(!u.is_healthy());
    }

    #[test]
    fn is_present_only_null_is_absent() {
        assert!(!is_present(&Value::Null));
        assert!(is_present(&json_str("")));
        assert!(is_present(&Value::Bool(false)));
        assert!(is_present(&serde_json::json!(0)));
    }

    #[test]
    fn defaults_match_contract() {
        assert_eq!(DEFAULT_CACHE_TTL, Duration::from_secs(30));
        assert_eq!(DEFAULT_TOKEN_REFRESH_BUFFER_SECONDS, 60);
    }

    fn json_str(s: &str) -> Value {
        Value::String(s.to_string())
    }
}
