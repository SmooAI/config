<!-- Improved compatibility of back to top link: See: https://github.com/othneildrew/Best-README-Template/pull/73 -->

<a name="readme-top"></a>

<!-- PROJECT LOGO -->
<br />
<div align="center">
  <a href="https://smoo.ai">
    <img src="images/logo.png" alt="SmooAI Logo" />
  </a>
</div>

<!-- ABOUT THE PROJECT -->

## About SmooAI

SmooAI is an AI-powered platform for helping businesses multiply their customer, employee, and developer experience.

Learn more on [smoo.ai](https://smoo.ai)

## SmooAI Packages

Check out other SmooAI packages at [smoo.ai/open-source](https://smoo.ai/open-source)

## About @smooai/config

**Type-safe configuration management for every layer of your stack** - Define configuration schemas once, validate everywhere, and manage public settings, secrets, and feature flags across TypeScript, Python, Rust, and Go.

![NPM Version](https://img.shields.io/npm/v/%40smooai%2Fconfig?style=for-the-badge)
![NPM Downloads](https://img.shields.io/npm/dw/%40smooai%2Fconfig?style=for-the-badge)
![NPM Last Update](https://img.shields.io/npm/last-update/%40smooai%2Fconfig?style=for-the-badge)

![GitHub License](https://img.shields.io/github/license/SmooAI/config?style=for-the-badge)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/SmooAI/config/release.yml?style=for-the-badge)
![GitHub Repo stars](https://img.shields.io/github/stars/SmooAI/config?style=for-the-badge)

### Why @smooai/config?

Ever scattered configuration values across environment variables, JSON files, and hardcoded strings? Or struggled to keep configuration consistent across microservices written in different languages? Traditional config management gives you the values, but not the safety.

**@smooai/config provides:**

- **Three configuration tiers** - Separate public config, secrets, and feature flags with distinct schemas
- **Schema-agnostic validation** - Works with Zod, Valibot, ArkType, Effect Schema, or any StandardSchema-compliant library
- **Type-safe keys** - Automatic camelCase-to-UPPER_SNAKE_CASE mapping with full TypeScript inference
- **JSON Schema serialization** - Convert any schema to JSON Schema for cross-language interoperability
- **Runtime client** - Fetch configuration from a centralized config server with local caching
- **Multi-language support** - Native implementations in TypeScript, Python, Rust, and Go

### Install

#### TypeScript / JavaScript

```sh
pnpm add @smooai/config
```

#### Python

```sh
pip install smooai-config
```

or with [uv](https://docs.astral.sh/uv/):

```sh
uv add smooai-config
```

#### Rust

```toml
[dependencies]
smooai-config = { git = "https://github.com/SmooAI/config", package = "smooai-config" }
```

#### Go

```sh
go get github.com/SmooAI/config/go/config
```

## Usage

### TypeScript - Define Configuration Schemas

Use any StandardSchema-compliant validation library to define your configuration:

```typescript
import { defineConfig, StringSchema, BooleanSchema, NumberSchema } from '@smooai/config';
import { z } from 'zod';

const config = defineConfig({
    publicConfigSchema: {
        apiUrl: z.string().url(),
        maxRetries: NumberSchema,
        enableDebug: BooleanSchema,
    },
    secretConfigSchema: {
        databaseUrl: z.string().url(),
        apiKey: StringSchema,
    },
    featureFlagSchema: {
        enableNewUI: BooleanSchema,
        betaFeatures: BooleanSchema,
    },
});
```

Supports Zod, Valibot, ArkType, Effect Schema, and built-in schema types - see [SCHEMA_USAGE.md](SCHEMA_USAGE.md) for examples with each library.

### Python - Define and Fetch Configuration

```python
from pydantic import BaseModel
from smooai_config import define_config, ConfigTier
from smooai_config.client import ConfigClient

# Define schemas using Pydantic models
class PublicConfig(BaseModel):
    api_url: str = "https://api.example.com"
    max_retries: int = 3

class SecretConfig(BaseModel):
    database_url: str
    api_key: str

config = define_config(
    public=PublicConfig,
    secret=SecretConfig,
)

# Fetch values at runtime
with ConfigClient(
    base_url="https://config.smooai.dev",
    api_key="your-api-key",
    org_id="your-org-id",
) as client:
    value = client.get_value("API_URL", environment="production")
    all_values = client.get_all_values(environment="production")
```

### Rust - Define and Fetch Configuration

```rust
use smooai_config::{define_config, ConfigTier};
use smooai_config::client::ConfigClient;

// Define configuration tiers
let config = define_config(
    Some(vec![("api_url", "https://api.example.com")]),
    Some(vec![("database_url", "postgres://...")]),
    None,
);

// Fetch values at runtime
let client = ConfigClient::new(
    "https://config.smooai.dev",
    "your-api-key",
    "your-org-id",
);
let value = client.get_value("API_URL", "production").await?;
```

### Go - Define and Fetch Configuration

```go
import "github.com/SmooAI/config/go/config"

// Define configuration
cfg := config.DefineConfig(
    map[string]interface{}{"apiUrl": "https://api.example.com"},
    map[string]interface{}{"databaseUrl": "postgres://..."},
    nil,
)

// Fetch values at runtime
client := config.NewClient(
    "https://config.smooai.dev",
    "your-api-key",
    "your-org-id",
)
value, err := client.GetValue("API_URL", "production")
allValues, err := client.GetAllValues("production")
```

## Configuration Tiers

| Tier              | Purpose                 | Examples                                 |
| ----------------- | ----------------------- | ---------------------------------------- |
| **Public**        | Client-visible settings | API URLs, feature toggles, UI config     |
| **Secret**        | Server-side only        | Database URLs, API keys, JWT secrets     |
| **Feature Flags** | Runtime toggles         | A/B tests, gradual rollouts, beta access |

Each tier gets its own schema, validation, and JSON Schema output for cross-language consumption.

## Development

### Prerequisites

- Node.js 22+, pnpm 10+
- Python 3.13+ with uv
- Rust toolchain (rustup)
- Go 1.22+

### Commands

```sh
pnpm install               # Install dependencies
pnpm build                 # Build all packages (TS, Python, Rust, Go)
pnpm test                  # Run all tests (Vitest, pytest, cargo test, go test)
pnpm lint                  # Lint all code (oxlint, ruff, clippy, go vet)
pnpm format                # Format all code (oxfmt, ruff, cargo fmt, gofmt)
pnpm typecheck             # Type check (tsc, basedpyright, cargo check)
pnpm check-all             # Full CI parity check
```

### Built With

- **TypeScript** - Core implementation with StandardSchema support
- **Python** - Pydantic-based schemas with httpx runtime client
- **Rust** - Serde-based schemas with reqwest async client
- **Go** - Native schemas with net/http client and local caching
- [StandardSchema](https://github.com/standard-schema/standard-schema) - Schema-agnostic validation
- [Zod](https://zod.dev/), [Valibot](https://valibot.dev/), [ArkType](https://arktype.io/), [Effect](https://effect.website/) - Supported validation libraries

## Contributing

Contributions are welcome! This project uses [changesets](https://github.com/changesets/changesets) to manage versions and releases.

### Development Workflow

1. Fork the repository
2. Create your branch (`git checkout -b amazing-feature`)
3. Make your changes
4. Add a changeset to document your changes:

    ```sh
    pnpm changeset
    ```

    This will prompt you to:
    - Choose the type of version bump (patch, minor, or major)
    - Provide a description of the changes

5. Commit your changes (`git commit -m 'Add some amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

### Pull Request Guidelines

- Reference any related issues in your PR description

The maintainers will review your PR and may request changes before merging.

<!-- CONTACT -->

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Contact

Brent Rager

- [Email](mailto:brent@smoo.ai)
- [LinkedIn](https://www.linkedin.com/in/brentrager/)
- [BlueSky](https://bsky.app/profile/brentragertech.bsky.social)
- [TikTok](https://www.tiktok.com/@brentragertech)
- [Instagram](https://www.instagram.com/brentragertech/)

Smoo Github: [https://github.com/SmooAI](https://github.com/SmooAI)

<p align="right">(<a href="#readme-top">back to top</a>)</p>
