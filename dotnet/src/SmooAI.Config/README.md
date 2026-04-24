# SmooAI.Config

[![NuGet](https://img.shields.io/nuget/v/SmooAI.Config.svg)](https://www.nuget.org/packages/SmooAI.Config)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

.NET client for **[SmooAI.Config](https://smoo.ai)** — the OpenAI-compatible
configuration service for your entire stack. One schema, one API, every
language. Typed access to public values, secrets, and feature flags from
any .NET app, with a local-baked runtime for zero-latency cold starts.

Wire-compatible with the TypeScript, Python, Rust and Go clients — the same
encrypted bundle decrypts and resolves to the same keys no matter which
language you ship.

## Install

```sh
dotnet add package SmooAI.Config
```

## What you get

- **HTTP client** with OAuth2 client-credentials auth, token caching, and 401 retry
- **Local runtime** — AES-256-GCM decrypt of a baked config bundle for zero-network reads at cold start
- **Build pipeline** — fetch all values and encrypt them into a bundle your deploy tool ships with the function
- **Strongly-typed keys** via a Roslyn source generator — mis-typed keys fail at compile time
- **Feature flag support** — live-fetched through the client, never baked

## Quickstart

### 1. Point the generator at your schema

In your csproj:

```xml
<ItemGroup>
  <AdditionalFiles Include="schema.json" SmooConfigSchema="true" />
</ItemGroup>
```

Your `schema.json` (emitted by `smooai-config init` / `smooai-config push`):

```json
{
    "publicConfigSchema": { "apiUrl": "stringSchema", "retries": "numberSchema" },
    "secretConfigSchema": { "moonshotApiKey": "stringSchema", "anthropicApiKey": "stringSchema" },
    "featureFlagSchema": { "newFlow": "booleanSchema" }
}
```

### 2. Use the generated typed keys

```csharp
using SmooAI.Config;
using SmooAI.Config.Generated;
using SmooAI.Config.Runtime;

var runtime = SmooConfigRuntime.Load();  // reads SMOO_CONFIG_KEY_FILE + SMOO_CONFIG_KEY
using var client = new SmooConfigClient(new SmooConfigClientOptions
{
    ClientId     = Environment.GetEnvironmentVariable("SMOOAI_CLIENT_ID")!,
    ClientSecret = Environment.GetEnvironmentVariable("SMOOAI_CLIENT_SECRET")!,
    OrgId        = Environment.GetEnvironmentVariable("SMOOAI_ORG_ID")!,
});

// Public + secret come from the baked runtime (sync, no network).
// Feature flags fall through to the HTTP client automatically.
var apiUrl    = await Public.ApiUrl.ResolveAsync(runtime, client);
var moonshot  = await Secrets.MoonshotApiKey.ResolveAsync(runtime, client);
var newFlow   = await FeatureFlags.NewFlow.ResolveAsync(runtime, client);
```

No stringly-typed keys. Rename a key in `schema.json` and every call site
becomes a compile-time error.

## The three pieces

### HTTP client

OAuth2 client-credentials flow against `{baseUrl}/token` (with the `api.`
subdomain rewritten to `auth.`), tokens cached in memory and refreshed 60
seconds before expiry, automatic 401 retry.

```csharp
using var client = new SmooConfigClient(new SmooConfigClientOptions
{
    ClientId     = "...",
    ClientSecret = "sk_...",
    OrgId        = "...",
    BaseUrl      = "https://api.smoo.ai",       // default
    DefaultEnvironment = "production",           // default
});

// Untyped
JsonElement value = await client.GetValueAsync("moonshotApiKey");
Dictionary<string, JsonElement> all = await client.GetAllValuesAsync();

// Typed (via generated keys)
string? anthropic = await Secrets.AnthropicApiKey.GetAsync(client);
```

### Local runtime

Decrypts a pre-built bundle at cold start and exposes it in-memory. Parity
with the TS / Python / Rust / Go runtimes — blob layout is
`nonce (12 bytes) || ciphertext || authTag (16 bytes)`, AES-256-GCM.

Set two env vars on your function:

| Variable               | Value                                      |
| ---------------------- | ------------------------------------------ |
| `SMOO_CONFIG_KEY_FILE` | Absolute path to the `.enc` bundle on disk |
| `SMOO_CONFIG_KEY`      | Base64-encoded 32-byte AES-256 key         |

```csharp
var runtime = SmooConfigRuntime.Load();   // null when env vars are unset — dev fallback
if (runtime is null) {
    // No baked bundle present; fall back to a live-fetching client.
}

var apiUrl = runtime?.GetPublic("apiUrl")?.GetString();
var retries = runtime?.GetValue<int>("retries");
```

### Build pipeline

Bake all public + secret values into an encrypted bundle at deploy time.
Feature flags are skipped — they stay live-fetched so you can flip them
without a redeploy.

```csharp
using var client = new SmooConfigClient(clientOptions);

var classify = SchemaClassifier.FromSchemaFile(".smooai-config/schema.json");
var result = await SmooConfigBuilder.BuildAsync(client, new BuildBundleOptions
{
    Environment = "production",
    Classify    = classify,
});

File.WriteAllBytes("smoo-config.enc", result.Bundle);

Console.WriteLine($"SMOO_CONFIG_KEY_FILE={Path.GetFullPath("smoo-config.enc")}");
Console.WriteLine($"SMOO_CONFIG_KEY={result.KeyB64}");
Console.WriteLine($"Baked {result.KeyCount} keys ({result.SkippedCount} feature flags skipped).");
```

Ship `smoo-config.enc` alongside the function bundle, set the two env vars
on the function, and the runtime picks up both automatically.

## Wire compatibility

The `.NET` client produces and consumes **exactly** the same bundle format
as every other SmooAI.Config language client:

- `@smooai/config` (TypeScript)
- `smooai-config` (Python)
- `smooai_config` (Rust)
- `github.com/smooai/config/go` (Go)

You can bake the bundle in any language and decrypt it in any other.

## Links

- **Homepage**: [smoo.ai](https://smoo.ai)
- **Source**: [github.com/SmooAI/config](https://github.com/SmooAI/config)
- **Issues**: [github.com/SmooAI/config/issues](https://github.com/SmooAI/config/issues)
- **License**: MIT
