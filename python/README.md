<!-- Improved compatibility of back to top link: See: https://github.com/othneildrew/Best-README-Template/pull/73 -->

<a name="readme-top"></a>

<!-- PROJECT LOGO -->
<br />
<div align="center">
  <a href="https://smoo.ai">
    <img src="../../images/logo.png" alt="SmooAI Logo" />
  </a>
</div>

<!-- ABOUT THE PROJECT -->

## About SmooAI

SmooAI is an AI-powered platform for helping businesses multiply their customer, employee, and developer experience.

Learn more on [smoo.ai](https://smoo.ai)

## SmooAI Packages

Check out other SmooAI packages at [smoo.ai/open-source](https://smoo.ai/open-source)

## About smooai-config (Python)

**Type-safe config, secrets, and feature flags for Python** - Same schema, same keys, same source of truth as your TypeScript, Rust, Go, and .NET services. Validated by Pydantic at the edge.

![PyPI Version](https://img.shields.io/pypi/v/smooai-config?style=for-the-badge)
![PyPI Downloads](https://img.shields.io/pypi/dw/smooai-config?style=for-the-badge)
![PyPI Last Update](https://img.shields.io/pypi/last-update/smooai-config?style=for-the-badge)

![GitHub License](https://img.shields.io/github/license/SmooAI/config?style=for-the-badge)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/SmooAI/config/release.yml?style=for-the-badge)
![GitHub Repo stars](https://img.shields.io/github/stars/SmooAI/config?style=for-the-badge)

### Python Package

The Python port of [@smooai/config](https://www.npmjs.com/package/@smooai/config). Define your schema with Pydantic `BaseModel` classes once and every Python service in your stack reads the same typed values as your TypeScript frontend or Go backend.

### What you get

- **Three tiers, one schema** - public config, secrets, and feature flags separated cleanly as three Pydantic `BaseModel` classes.
- **Pydantic-validated at the edge** - invalid values raise before they land in business logic.
- **Any environment, any key** - same API for `development`, `staging`, `production` with per-stage overrides.
- **Cross-language source of truth** - the schemas you define in Python are the same ones your TypeScript, Rust, Go, and .NET services read.
- **Zero-config client setup** - pick up `SMOOAI_CONFIG_*` from env vars and go.
- **Thread-safe + context-managed** - `with ConfigClient(...) as client:` handles caching and connection cleanup for you.

### Install

```bash
pip install smooai-config
```

or with [uv](https://docs.astral.sh/uv/):

```bash
uv add smooai-config
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

### Define Configuration Schemas

Use Pydantic `BaseModel` classes to define each configuration tier:

```python
from pydantic import BaseModel
from smooai_config import define_config

class PublicConfig(BaseModel):
    api_url: str = "https://api.example.com"
    max_retries: int = 3
    enable_debug: bool = False

class SecretConfig(BaseModel):
    database_url: str
    api_key: str

class FeatureFlags(BaseModel):
    enable_new_ui: bool = False
    beta_features: bool = False

config = define_config(
    public=PublicConfig,
    secret=SecretConfig,
    feature_flags=FeatureFlags,
)

# Access per-tier JSON schemas
print(config.public_schema)
print(config.secret_schema)
print(config.feature_flag_schema)

# Full combined JSON Schema (JSON Schema Draft 2020-12)
print(config.json_schema)
```

### Runtime Client - Fetch Values from Server

The `ConfigClient` fetches live configuration values from the Smoo AI config server. It supports context managers for clean resource management:

```python
from smooai_config.client import ConfigClient

# Option 1: Use environment variables (zero-config)
# Reads SMOOAI_CONFIG_API_URL, SMOOAI_CONFIG_API_KEY, SMOOAI_CONFIG_ORG_ID
with ConfigClient() as client:
    value = client.get_value("API_URL")
    all_values = client.get_all_values()

# Option 2: Explicit configuration
with ConfigClient(
    base_url="https://config.smooai.dev",
    api_key="your-api-key",
    org_id="your-org-id",
    environment="production",
) as client:
    # Fetch a single value
    api_url = client.get_value("API_URL")

    # Fetch with environment override
    staging_url = client.get_value("API_URL", environment="staging")

    # Fetch all values for the default environment
    all_values = client.get_all_values()

    # Fetch all values for a specific environment
    prod_values = client.get_all_values(environment="production")
```

### Caching

The client caches fetched values locally. Cache TTL can be configured:

```python
from smooai_config.client import ConfigClient

with ConfigClient(
    base_url="https://config.smooai.dev",
    api_key="your-api-key",
    org_id="your-org-id",
    cache_ttl_seconds=300,  # Cache for 5 minutes
) as client:
    value = client.get_value("API_URL")  # Fetched from server
    value = client.get_value("API_URL")  # Served from cache

    # Invalidate all cached values
    client.invalidate_cache()

    # Invalidate cached values for one environment
    client.invalidate_cache_for_environment("production")
```

### Local Configuration Manager

For local development or offline environments, `LocalConfigManager` loads configuration from `.smooai-config/` files and environment variables:

```python
from smooai_config import LocalConfigManager

manager = LocalConfigManager()

# Fetch values from local file config + env vars
api_url = manager.get_public_config("API_URL")
db_url = manager.get_secret_config("DATABASE_URL")
new_ui = manager.get_feature_flag("ENABLE_NEW_UI")
```

### Unified Config Manager

`ConfigManager` merges three sources in priority order (env vars > remote API > file config):

```python
from smooai_config import ConfigManager

manager = ConfigManager(
    api_key="your-api-key",
    base_url="https://config.smooai.dev",
    org_id="your-org-id",
    environment="production",
)

value = manager.get_public_config("API_URL")
```

### Baked Runtime — zero-network cold starts

For Lambda / ECS / long-lived services, bake every public + secret value into an AES-256-GCM blob at deploy time and decrypt it at cold start. Reads then resolve from in-memory cache with no HTTP round-trip. Feature flags are intentionally skipped — they stay live-fetched so you can toggle without a redeploy.

The runtime is a thin hydrator on top of `ConfigClient`: it decrypts the blob and pre-seeds the client cache. Subsequent `client.get_value(key)` calls resolve sync from cache.

```python
from smooai_config.runtime import build_config_runtime

# At process boot (cold start). Reads SMOO_CONFIG_KEY_FILE + SMOO_CONFIG_KEY,
# decrypts the blob, and seeds an internal ConfigClient cache.
client = build_config_runtime()

# Public + secret values come from the in-memory cache (no network).
api_url = client.get_value("apiUrl")
sendgrid = client.get_value("sendgridApiKey")

# Feature flags are not baked — these still hit the API.
new_flow = client.get_value("newFlow")
```

Bake the bundle at deploy time:

```python
from smooai_config.build import build_bundle, classify_from_schema

result = build_bundle(
    base_url="https://config.smooai.dev",
    api_key="your-api-key",
    org_id="your-org-id",
    environment="production",
    classify=classify_from_schema(
        public_keys={"apiUrl"},
        secret_keys={"sendgridApiKey"},
        feature_flag_keys={"newFlow"},  # skipped (stays live)
    ),
)

# Write the blob next to your deploy artifact and set both env vars on the
# function. The blob layout is wire-compatible with every other SDK.
with open("smoo-config.enc", "wb") as fh:
    fh.write(result.bundle)

print(f"SMOO_CONFIG_KEY_FILE=/abs/path/to/smoo-config.enc")
print(f"SMOO_CONFIG_KEY={result.key_b64}")
```

#### Blob env vars

| Variable               | Value                                      |
| ---------------------- | ------------------------------------------ |
| `SMOO_CONFIG_KEY_FILE` | Absolute path to the `.enc` bundle on disk |
| `SMOO_CONFIG_KEY`      | Base64-encoded 32-byte AES-256 key         |

Without both set, `build_config_runtime()` falls back to a plain `ConfigClient` so dev machines without a baked blob still work — the API stays uniform either way.

The blob format is `nonce (12 bytes) || ciphertext || authTag (16 bytes)` — wire-identical to the TypeScript, Rust, Go, and .NET runtimes. A blob baked in any language decrypts in any other.

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

### `Cannot read properties of undefined` / passing `None` to `get_value`

If you read `SecretConfigKeys.X` (or `PublicConfigKeys.X` / `FeatureFlagKeys.X`) for a key that wasn't declared in the schema your service was built against, the constant resolves to `None` / `undefined` and you'll see a typed error pointing at the missing key. The common cause is a schema rebase mismatch — the consumer was built against an older `schema.json` than the one declared in your config repo. Re-run `smooai-config push` (or the equivalent generator step) to pick up the new keys, or add the missing key to your schema.

## Built With

- Python 3.13+ - Full type hints and Pydantic v2 support
- [Pydantic](https://docs.pydantic.dev/) - Schema definition and validation
- [httpx](https://www.python-httpx.org/) - HTTP client for runtime config fetching
- Thread-safe caching with `threading.RLock`
- Context manager support for clean resource lifecycle

## Related Packages

- [@smooai/config](https://www.npmjs.com/package/@smooai/config) - TypeScript/JavaScript version
- [smooai-config (Python)](https://pypi.org/project/smooai-config/) - This package
- [smooai-config (Rust)](https://crates.io/crates/smooai-config) - Rust version
- `github.com/SmooAI/config/go/config` - Go version
- [SmooAI.Config (NuGet)](https://www.nuget.org/packages/SmooAI.Config) - .NET version
- [SmooAI/config](https://github.com/SmooAI/config) - GitHub repository

## Development

```bash
uv sync
uv run poe install-dev
uv run pytest
uv run poe lint
uv run poe lint:fix   # optional fixer
uv run poe format
uv run poe typecheck
uv run poe build
```

Set `UV_PUBLISH_TOKEN` before running `uv run poe publish` to upload to PyPI.

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
