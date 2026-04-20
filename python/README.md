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

**Type-safe configuration management for Python services** - Define configuration schemas with Pydantic, validate across tiers, and fetch values from the centralized Smoo AI config server with local caching and thread safety.

![PyPI Version](https://img.shields.io/pypi/v/smooai-config?style=for-the-badge)
![PyPI Downloads](https://img.shields.io/pypi/dw/smooai-config?style=for-the-badge)
![PyPI Last Update](https://img.shields.io/pypi/last-update/smooai-config?style=for-the-badge)

![GitHub License](https://img.shields.io/github/license/SmooAI/config?style=for-the-badge)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/SmooAI/config/release.yml?style=for-the-badge)
![GitHub Repo stars](https://img.shields.io/github/stars/SmooAI/config?style=for-the-badge)

### Python Package

This is the Python port of [@smooai/config](https://www.npmjs.com/package/@smooai/config), mirroring the TypeScript feature set for backend services. Define schemas with familiar Pydantic models, generate JSON Schema for cross-language interoperability, and use the runtime client to fetch live configuration values from any Python environment.

### Priority chain

Every config read — sync or async, public or secret — runs the same **fallback chain** as the TypeScript SDK (see [main README — Priority Chain](../README.md#priority-chain) for diagrams + rationale):

| #   | Source                              | Notes                                                      |
| --- | ----------------------------------- | ---------------------------------------------------------- |
| 1   | **Baked blob**                      | AES-GCM file on disk, decrypted once at process start      |
| 2   | **Environment variables**           | `os.environ[UPPER_SNAKE_CASE(key)]`                        |
| 3   | **HTTP config API** (`api.smoo.ai`) | live fetch via `httpx`, 30s cache                          |
| 4   | **Local file defaults**             | `.smooai-config/<env>.py` / `.json` / `.yaml`, deep-merged |

**First non-empty source wins** — later sources don't override earlier ones. Feature flags flip to HTTP-first and skip the blob (live-toggleable by design).

Parity for the unified `build_config(schema)` surface is tracked in [SMOODEV-612](https://smooai.atlassian.net/browse/SMOODEV-612). Until it lands, this package exposes:

- `define_config(...)` + Pydantic schemas (unchanged)
- `ConfigClient` — HTTP-only tier (no blob / env / file fallback yet)

Callers that need the full priority chain today can wrap `ConfigClient` with their own fallback logic, or use the TypeScript SDK from a Node sidecar. Production Python services don't need this today since the Python AI server pulls most config via env vars set by SST.

### Why smooai-config?

Ever scattered configuration across environment variables, dotenv files, and hardcoded values across your Python microservices? Or struggled to keep configuration consistent between TypeScript frontends and Python backends? Traditional config management gives you the values, but not the safety.

**smooai-config provides:**

- **Three configuration tiers** - Separate public config, secrets, and feature flags with distinct Pydantic schemas
- **Pydantic-native schemas** - Use familiar `BaseModel` definitions with full type validation
- **JSON Schema generation** - Export schemas for cross-language consumption by TypeScript, Rust, and Go services
- **Cross-language compatibility validation** - Catches unsupported JSON Schema features at schema definition time
- **Thread-safe runtime client** - Fetch configuration from the Smoo AI config server with local caching and `RLock` safety
- **Context manager support** - Clean `with ConfigClient(...) as client:` usage with automatic HTTP connection cleanup
- **Environment variable fallback** - Zero-config client setup via `SMOOAI_CONFIG_*` environment variables

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
