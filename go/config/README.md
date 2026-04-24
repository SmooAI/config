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

## About smooai-config (Go)

**Type-safe config, secrets, and feature flags for Go** - Same schema, same keys, same source of truth as your TypeScript, Python, Rust, and .NET services. All typed, all thread-safe.

![GitHub License](https://img.shields.io/github/license/SmooAI/config?style=for-the-badge)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/SmooAI/config/release.yml?style=for-the-badge)
![GitHub Repo stars](https://img.shields.io/github/stars/SmooAI/config?style=for-the-badge)

### Go Package

Go port of [@smooai/config](https://www.npmjs.com/package/@smooai/config). Define your config with Go structs and tags — the same schema your TypeScript frontend or Rust service reads.

### What you get

- **Three tiers, one schema** - public config, secrets, and feature flags as three Go structs with struct tags.
- **Native Go structs** - `json` and `jsonschema` tags are all you need; `DefineConfigTyped` generates the schema every other service reads.
- **Any environment, any key** - same API for `development`, `staging`, `production` with per-stage overrides.
- **Cross-language source of truth** - same schema lives in TypeScript, Python, Rust, and .NET services.
- **Zero-config client setup** - `NewConfigClientFromEnv` picks up `SMOOAI_CONFIG_*` and goes.
- **Thread-safe caching** - fetched values stay in-process between calls; invalidate on demand or set a TTL via `WithCacheTTL`.

### Install

```bash
go get github.com/SmooAI/config/go/config
```

#### All Language Packages

| Language   | Package                                                          | Install                                     |
| ---------- | ---------------------------------------------------------------- | ------------------------------------------- |
| TypeScript | [`@smooai/config`](https://www.npmjs.com/package/@smooai/config) | `pnpm add @smooai/config`                   |
| Python     | [`smooai-config`](https://pypi.org/project/smooai-config/)       | `pip install smooai-config`                 |
| Rust       | [`smooai-config`](https://crates.io/crates/smooai-config)        | `cargo add smooai-config`                   |
| Go         | `github.com/SmooAI/config/go/config`                             | `go get github.com/SmooAI/config/go/config` |

## Usage

### Define Configuration Schemas with Native Go Structs

The preferred way to define configuration is with Go structs using `DefineConfigTyped`. Struct field tags control JSON Schema output:

```go
import "github.com/SmooAI/config/go/config"

type PublicConfig struct {
    APIUrl     string `json:"api_url"`
    MaxRetries int    `json:"max_retries" jsonschema:"minimum=0"`
    EnableDebug bool  `json:"enable_debug"`
}

type SecretConfig struct {
    DatabaseURL string `json:"database_url"`
    APIKey      string `json:"api_key"`
}

type FeatureFlags struct {
    EnableNewUI  bool `json:"enable_new_ui"`
    BetaFeatures bool `json:"beta_features"`
}

// Generates JSON Schema from your Go structs and validates cross-language compatibility
cfg, err := config.DefineConfigTyped(&PublicConfig{}, &SecretConfig{}, &FeatureFlags{})
if err != nil {
    log.Fatal(err)
}

jsonBytes, _ := json.MarshalIndent(cfg.JSONSchema, "", "  ")
fmt.Println(string(jsonBytes))
```

### Define Configuration Schemas from Raw JSON Schema

Alternatively, pass raw JSON Schema maps directly:

```go
import "github.com/SmooAI/config/go/config"

publicSchema := map[string]any{
    "type": "object",
    "properties": map[string]any{
        "api_url":     map[string]any{"type": "string"},
        "max_retries": map[string]any{"type": "integer"},
    },
}

cfg := config.DefineConfig(
    publicSchema,
    nil, // no secret tier
    nil, // no feature flags
)
```

### Runtime Client - Fetch Values from Server

The `ConfigClient` uses the standard `net/http` package with a custom `authTransport` that injects Bearer tokens. Responses are cached with `sync.RWMutex` for thread safety:

```go
import "github.com/SmooAI/config/go/config"

// Option 1: Use environment variables (zero-config)
// Reads SMOOAI_CONFIG_API_URL, SMOOAI_CONFIG_API_KEY, SMOOAI_CONFIG_ORG_ID
client := config.NewConfigClientFromEnv()
defer client.Close()

// Option 2: Explicit configuration (empty strings fall back to env vars)
client := config.NewConfigClient(
    "https://config.smooai.dev",
    "your-api-key",
    "your-org-id",
)
defer client.Close()

// Option 3: With TTL-based cache expiration
client := config.NewConfigClient(
    "https://config.smooai.dev",
    "your-api-key",
    "your-org-id",
    config.WithCacheTTL(5*time.Minute),
)
defer client.Close()

// Fetch a single value (empty string uses default environment)
value, err := client.GetValue("API_URL", "")
if err != nil {
    log.Fatal(err)
}

// Fetch with environment override
stagingURL, err := client.GetValue("API_URL", "staging")

// Fetch all values
allValues, err := client.GetAllValues("")
```

### Caching

The client caches fetched values locally. By default the cache never expires (manual invalidation only). Use `WithCacheTTL` to set a TTL:

```go
client := config.NewConfigClient(
    "https://config.smooai.dev",
    "your-api-key",
    "your-org-id",
    config.WithCacheTTL(5*time.Minute),
)
defer client.Close()

value, _ := client.GetValue("API_URL", "")  // Fetched from server and cached
value, _ = client.GetValue("API_URL", "")   // Served from cache

// Invalidate all cached values
client.InvalidateCache()

// Invalidate cached values for one environment
client.InvalidateCacheForEnvironment("production")
```

### Local Configuration Manager

For local development or offline environments, `LocalConfigManager` loads configuration from `.smooai-config/` files and environment variables with a 24-hour default TTL:

```go
import "github.com/SmooAI/config/go/config"

manager := config.NewLocalConfigManager(
    config.WithSchemaKeys(map[string]bool{
        "API_URL":     true,
        "DATABASE_URL": true,
    }),
    config.WithEnvPrefix("MYAPP_"),
)

// Fetch values from local file config + env vars
apiURL, err := manager.GetPublicConfig("API_URL")
dbURL, err := manager.GetSecretConfig("DATABASE_URL")
newUI, err := manager.GetFeatureFlag("ENABLE_NEW_UI")

// Invalidate to force re-load on next access
manager.Invalidate()
```

### Unified Config Manager

`ConfigManager` merges three sources in priority order (env vars > remote API > file config). It also supports deferred (computed) values:

```go
import "github.com/SmooAI/config/go/config"

manager := config.NewConfigManager(
    config.WithAPIKey("your-api-key"),
    config.WithBaseURL("https://config.smooai.dev"),
    config.WithOrgID("your-org-id"),
    config.WithConfigEnvironment("production"),
    config.WithDeferred("DERIVED_URL", func(cfg map[string]any) any {
        base, _ := cfg["API_URL"].(string)
        return base + "/v2"
    }),
)

value, err := manager.GetPublicConfig("API_URL")
derived, err := manager.GetPublicConfig("DERIVED_URL")
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

- Go 1.22+ - Native concurrency and standard library HTTP client
- [invopop/jsonschema](https://github.com/invopop/jsonschema) - JSON Schema generation from Go structs
- `sync.RWMutex` - Thread-safe caching
- Functional options pattern for idiomatic configuration

## Development

### Running tests

```bash
go test ./...
```

### Building

```bash
go build ./...
```

### Linting and Formatting

```bash
go vet ./...
gofmt -w .
```

## Related Packages

- [@smooai/config](https://www.npmjs.com/package/@smooai/config) - TypeScript/JavaScript version
- [smooai-config (Python)](https://pypi.org/project/smooai-config/) - Python version
- [smooai-config (Rust)](https://crates.io/crates/smooai-config) - Rust version
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
