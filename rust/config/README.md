<!-- Improved compatibility of back to top link: See: https://github.com/othneildrew/Best-README-Template/pull/73 -->

<a name="readme-top"></a>

<!-- PROJECT LOGO -->
<br />
<div align="center">
  <a href="https://smoo.ai">
    <img src="../../../images/logo.png" alt="SmooAI Logo" />
  </a>
</div>

<!-- ABOUT THE PROJECT -->

## About SmooAI

SmooAI is an AI-powered platform for helping businesses multiply their customer, employee, and developer experience.

Learn more on [smoo.ai](https://smoo.ai)

## SmooAI Packages

Check out other SmooAI packages at [smoo.ai/open-source](https://smoo.ai/open-source)

## About smooai-config (Rust)

**Type-safe config, secrets, and feature flags for Rust** - Same schema, same keys, same source of truth as your TypeScript, Python, Go, and .NET services. All strongly typed, all async.

![Crates.io Version](https://img.shields.io/crates/v/smooai-config?style=for-the-badge)
![Crates.io Downloads](https://img.shields.io/crates/d/smooai-config?style=for-the-badge)
![Crates.io License](https://img.shields.io/crates/l/smooai-config?style=for-the-badge)

![GitHub License](https://img.shields.io/github/license/SmooAI/config?style=for-the-badge)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/SmooAI/config/release.yml?style=for-the-badge)
![GitHub Repo stars](https://img.shields.io/github/stars/SmooAI/config?style=for-the-badge)

### Rust Crate

Rust port of [@smooai/config](https://www.npmjs.com/package/@smooai/config). Derive `JsonSchema` on your own Rust structs, generate the exact schema every other service in your stack reads, and resolve values through a cached async client.

### What you get

- **Three tiers, one schema** - public config, secrets, and feature flags as three Rust structs with `#[derive(JsonSchema)]`.
- **Strongly-typed, idiomatic Rust** - `define_config_typed::<Public, Secret, Flags>()` turns your structs into the schema every other service reads.
- **Any environment, any key** - same API for `development`, `staging`, `production` with per-stage overrides.
- **Cross-language source of truth** - the same schema lives in TypeScript, Python, Go, and .NET services.
- **Zero-config client setup** - `ConfigClient::from_env()` picks up `SMOOAI_CONFIG_*` and goes.
- **Async + cached** - fetched values stay in-process between calls; invalidate on demand or set a TTL.

### Install

Add to your `Cargo.toml`:

```toml
[dependencies]
smooai-config = "0.1"
```

or using cargo:

```bash
cargo add smooai-config
```

#### All Language Packages

| Language   | Package                                                          | Install                                     |
| ---------- | ---------------------------------------------------------------- | ------------------------------------------- |
| TypeScript | [`@smooai/config`](https://www.npmjs.com/package/@smooai/config) | `pnpm add @smooai/config`                   |
| Python     | [`smooai-config`](https://pypi.org/project/smooai-config/)       | `pip install smooai-config`                 |
| Rust       | [`smooai-config`](https://crates.io/crates/smooai-config)        | `cargo add smooai-config`                   |
| Go         | `github.com/SmooAI/config/go/config`                             | `go get github.com/SmooAI/config/go/config` |
| .NET       | [`SmooAI.Config`](https://www.nuget.org/packages/SmooAI.Config)  | `dotnet add package SmooAI.Config`          |

## Usage

### Define Configuration Schemas with Native Rust Types

The preferred way to define configuration is with Rust structs that derive `JsonSchema`. Use `EmptySchema` for tiers that have no configuration values:

```rust
use smooai_config::schema::{define_config_typed, EmptySchema};
use schemars::JsonSchema;
use serde::{Serialize, Deserialize};

#[derive(Default, Serialize, Deserialize, JsonSchema)]
struct PublicConfig {
    api_url: String,
    max_retries: u32,
    enable_debug: bool,
}

#[derive(Default, Serialize, Deserialize, JsonSchema)]
struct SecretConfig {
    database_url: String,
    api_key: String,
}

#[derive(Default, Serialize, Deserialize, JsonSchema)]
struct FeatureFlags {
    enable_new_ui: bool,
    beta_features: bool,
}

// Generates JSON Schema from your Rust types and validates cross-language compatibility
let config = define_config_typed::<PublicConfig, SecretConfig, FeatureFlags>();

println!("{}", serde_json::to_string_pretty(&config.json_schema).unwrap());
```

### Define Configuration Schemas from Raw JSON Schema

Alternatively, pass raw JSON Schema values directly:

```rust
use smooai_config::schema::define_config;

let public_schema = serde_json::json!({
    "type": "object",
    "properties": {
        "api_url": {"type": "string"},
        "max_retries": {"type": "integer"}
    }
});

let config = define_config(
    Some(public_schema),
    None, // no secret tier
    None, // no feature flags
);
```

### Runtime Client - Fetch Values from Server

The `ConfigClient` is async and uses `reqwest` under the hood. Fetched values are cached locally until `invalidate_cache` is called or a TTL expires:

```rust
use smooai_config::ConfigClient;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Option 1: Use environment variables (zero-config)
    // Reads SMOOAI_CONFIG_API_URL, SMOOAI_CONFIG_API_KEY, SMOOAI_CONFIG_ORG_ID
    let mut client = ConfigClient::from_env();

    // Option 2: Explicit configuration
    let mut client = ConfigClient::new(
        "https://config.smooai.dev",
        "your-api-key",
        "your-org-id",
    );

    // Option 3: Explicit with default environment
    let mut client = ConfigClient::with_environment(
        "https://config.smooai.dev",
        "your-api-key",
        "your-org-id",
        "production",
    );

    // Fetch a single value (None uses default environment)
    let api_url = client.get_value("API_URL", None).await?;

    // Fetch with environment override
    let staging_url = client.get_value("API_URL", Some("staging")).await?;

    // Fetch all values
    let all_values = client.get_all_values(None).await?;

    Ok(())
}
```

### Caching

Cache TTL can be configured with `set_cache_ttl`. By default the cache never expires (manual invalidation only):

```rust
use smooai_config::ConfigClient;
use std::time::Duration;

let mut client = ConfigClient::new(
    "https://config.smooai.dev",
    "your-api-key",
    "your-org-id",
);

// Set a 5-minute TTL
client.set_cache_ttl(Some(Duration::from_secs(300)));

// Fetched from server and cached
let value = client.get_value("API_URL", None).await?;

// Served from cache
let value = client.get_value("API_URL", None).await?;

// Invalidate all cached values
client.invalidate_cache();

// Invalidate cached values for one environment
client.invalidate_cache_for_environment("production");
```

### Local Configuration Manager

For local development or offline environments, `LocalConfigManager` loads configuration from `.smooai-config/` files and environment variables:

```rust
use smooai_config::LocalConfigManager;

let manager = LocalConfigManager::new(None, None, None)?;

// Fetch values from local file config + env vars
let api_url = manager.get_public_config("API_URL")?;
let db_url = manager.get_secret_config("DATABASE_URL")?;
let new_ui = manager.get_feature_flag("ENABLE_NEW_UI")?;
```

### Baked Runtime — zero-network cold starts

For Lambda / ECS / long-lived services, bake every public + secret value into an AES-256-GCM blob at deploy time and decrypt it at cold start. `build_config_runtime` decrypts the blob and seeds the manager's merged config map, so public/secret reads resolve from in-memory cache with no HTTP round-trip. Feature flags are skipped (the baker drops them) so they stay live-fetched.

```rust
use smooai_config::{build_config_runtime, RuntimeOptions};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Reads SMOO_CONFIG_KEY_FILE + SMOO_CONFIG_KEY, decrypts the blob, and
    // seeds the manager. With no env vars set, returns a regular live-fetch
    // ConfigManager — same API either way.
    let manager = build_config_runtime(RuntimeOptions {
        environment: Some("production".to_string()),
        ..Default::default()
    })
    .await?;

    let api_url = manager.get_public_config("apiUrl")?;
    let sendgrid = manager.get_secret_config("sendgridApiKey")?;
    Ok(())
}
```

Bake the bundle at deploy time:

```rust
use std::collections::HashSet;
use smooai_config::{build_bundle, BuildBundleOptions, Classification};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Schema-driven classifier — feature flags must return Skip so they stay live.
    let public_keys: HashSet<String> = ["apiUrl"].into_iter().map(String::from).collect();
    let secret_keys: HashSet<String> = ["sendgridApiKey"].into_iter().map(String::from).collect();
    let flag_keys: HashSet<String> = ["newFlow"].into_iter().map(String::from).collect();

    let result = build_bundle(BuildBundleOptions {
        base_url: "https://config.smooai.dev".to_string(),
        api_key: "your-api-key".to_string(),
        org_id: "your-org-id".to_string(),
        environment: Some("production".to_string()),
        classify: Some(Box::new(move |key, _v| {
            if secret_keys.contains(key) { Classification::Secret }
            else if flag_keys.contains(key) { Classification::Skip }
            else if public_keys.contains(key) { Classification::Public }
            else { Classification::Public }
        })),
    })
    .await?;

    std::fs::write("smoo-config.enc", &result.blob)?;
    println!("SMOO_CONFIG_KEY_FILE=/abs/path/to/smoo-config.enc");
    println!("SMOO_CONFIG_KEY={}", result.key_b64);
    Ok(())
}
```

#### Blob env vars

| Variable               | Value                                      |
| ---------------------- | ------------------------------------------ |
| `SMOO_CONFIG_KEY_FILE` | Absolute path to the `.enc` bundle on disk |
| `SMOO_CONFIG_KEY`      | Base64-encoded 32-byte AES-256 key         |

Without both set, `build_config_runtime` returns a plain `ConfigManager` so dev machines without a baked blob still work — the API stays uniform either way.

The blob format is `nonce (12 bytes) || ciphertext || authTag (16 bytes)` — wire-identical to the TypeScript, Python, Go, and .NET runtimes. A blob baked in any language decrypts in any other.

## Environment Variables

All clients read from the same set of environment variables:

| Variable                | Description                                            | Required |
| ----------------------- | ------------------------------------------------------ | -------- |
| `SMOOAI_CONFIG_API_URL` | Base URL of the config API                             | Yes      |
| `SMOOAI_CONFIG_API_KEY` | Bearer token for authentication                        | Yes      |
| `SMOOAI_CONFIG_ORG_ID`  | Organization ID                                        | Yes      |
| `SMOOAI_CONFIG_ENV`     | Default environment name (defaults to `"development"`) | No       |

Set these in your environment and the client will use them automatically:

```bash
export SMOOAI_CONFIG_API_URL="https://config.smooai.dev"
export SMOOAI_CONFIG_API_KEY="your-api-key"
export SMOOAI_CONFIG_ORG_ID="your-org-id"
export SMOOAI_CONFIG_ENV="production"
```

## Configuration Tiers

| Tier              | Purpose                 | Examples                                 |
| ----------------- | ----------------------- | ---------------------------------------- |
| **Public**        | Client-visible settings | API URLs, feature toggles, UI config     |
| **Secret**        | Server-side only        | Database URLs, API keys, JWT secrets     |
| **Feature Flags** | Runtime toggles         | A/B tests, gradual rollouts, beta access |

## Common errors

### `get_public_config` / `get_secret_config` returning `Ok(None)` for a known key

If you read a key that wasn't declared in the schema your service was built against, the manager's merged map has no entry and lookups return `Ok(None)`. The common cause is a schema rebase mismatch — the consumer was built against an older `schema.json` than what's in your config repo. Re-run the schema generator to pick up the new keys, or add the missing key to your schema.

## Built With

- Rust 2021 Edition - Memory safety and performance
- [schemars](https://docs.rs/schemars/) - JSON Schema generation from Rust types
- [serde](https://serde.rs/) / [serde_json](https://docs.rs/serde_json/) - JSON serialization
- [reqwest](https://docs.rs/reqwest/) - Async HTTP client
- [tokio](https://tokio.rs/) - Async runtime

## Development

### Running tests

```bash
cargo test
```

### Building

```bash
cargo build --release
```

### Linting and Formatting

```bash
cargo clippy
cargo fmt
```

## Related Packages

- [@smooai/config](https://www.npmjs.com/package/@smooai/config) - TypeScript/JavaScript version
- [smooai-config (Python)](https://pypi.org/project/smooai-config/) - Python version
- [smooai-config (Rust)](https://crates.io/crates/smooai-config) - This package
- `github.com/SmooAI/config/go/config` - Go version
- [SmooAI.Config (NuGet)](https://www.nuget.org/packages/SmooAI.Config) - .NET version
- [SmooAI/config](https://github.com/SmooAI/config) - GitHub repository

<!-- CONTACT -->

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Contact

Brent Rager

- [Email](mailto:brent@smoo.ai)
- [LinkedIn](https://www.linkedin.com/in/brentrager/)
- [BlueSky](https://bsky.app/profile/brentragertech.bsky.social)

Smoo Github: [https://github.com/SmooAI](https://github.com/SmooAI)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## License

MIT © SmooAI
