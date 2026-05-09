# SmooAI.Config

[![NuGet](https://img.shields.io/nuget/v/SmooAI.Config.svg)](https://www.nuget.org/packages/SmooAI.Config)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Type-safe config, secrets, and feature flags for .NET — one schema, every language, zero-latency cold starts.**

.NET client for **[SmooAI.Config](https://smoo.ai)**. Retrieve config values, secrets, and feature flags from your `.NET` app with keys that are **compile-time checked** by a Roslyn source generator — rename a key and every miss becomes a build error, not a 3 AM page.

The same encrypted bundle decrypts and resolves identically in the TypeScript, Python, Rust, and Go clients, so every service in your stack reads the same source of truth.

## Install

```sh
dotnet add package SmooAI.Config
```

## What you get

- **Strongly-typed keys** — `Public.ApiUrl`, `Secrets.MoonshotApiKey`, `FeatureFlags.NewFlow`. Mis-typed keys fail at compile time.
- **Schema-driven** — define your config once in `schema.json`; public values, secrets, and feature flags each get their own tier.
- **Zero-latency cold starts** — values are baked into an encrypted bundle shipped with your deploy, so reads are in-memory with no network hop.
- **Per-environment** — same keys, different values by stage (`development`, `staging`, `production`) with no code changes.
- **Live feature flags** — flags fall through to the runtime client so you can flip them without a redeploy.
- **Cross-language parity** — wire-compatible with the TypeScript, Python, Rust, and Go clients.

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

## How it fits together

Three pieces, one mental model: define the schema → bake the bundle at deploy → read typed values at runtime.

### Read typed values at runtime

The baked bundle is decrypted into memory at cold start. Public + secret values resolve synchronously, in-process, with zero network calls. Feature flags fall through to the live client so they stay flip-on-flip-off.

```csharp
var apiUrl = runtime?.GetPublic("apiUrl")?.GetString();
var retries = runtime?.GetValue<int>("retries");
```

Pair the runtime with the client for feature flags and cache misses:

```csharp
// Public + secret come from the baked runtime (sync, no network).
// Feature flags fall through to the HTTP client automatically.
var apiUrl   = await Public.ApiUrl.ResolveAsync(runtime, client);
var moonshot = await Secrets.MoonshotApiKey.ResolveAsync(runtime, client);
var newFlow  = await FeatureFlags.NewFlow.ResolveAsync(runtime, client);
```

### Bake the bundle at deploy

Fetch every current config value, encrypt them into a bundle, and ship that file alongside your function. Feature flags are skipped so you can still toggle them live.

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

Set two env vars on the function and the runtime picks them up automatically:

| Variable               | Value                                      |
| ---------------------- | ------------------------------------------ |
| `SMOO_CONFIG_KEY_FILE` | Absolute path to the `.enc` bundle on disk |
| `SMOO_CONFIG_KEY`      | Base64-encoded 32-byte AES-256 key         |

### Fetch live values (no bundle, or feature flags only)

```csharp
using var client = new SmooConfigClient(new SmooConfigClientOptions
{
    ClientId     = "...",
    ClientSecret = "sk_...",
    OrgId        = "...",
    BaseUrl      = "https://api.smoo.ai",       // default
    DefaultEnvironment = "production",           // default
});

// Typed
string? anthropic = await Secrets.AnthropicApiKey.GetAsync(client);

// Untyped
JsonElement value = await client.GetValueAsync("moonshotApiKey");
Dictionary<string, JsonElement> all = await client.GetAllValuesAsync();
```

## Under the hood

If you want the protocol detail — auth is OAuth2 client-credentials against `{baseUrl}/token` (the `api.` subdomain rewrites to `auth.`), tokens are cached in-memory and refreshed 60s before expiry, and the client retries 401 once after re-auth. The baked bundle format is `nonce (12 bytes) || ciphertext || authTag (16 bytes)` with AES-256-GCM — wire-identical to the TS / Python / Rust / Go runtimes so a bundle baked in any language decrypts in any other.

## Wire compatibility

The `.NET` client produces and consumes **exactly** the same bundle format
as every other SmooAI.Config language client:

- `@smooai/config` (TypeScript)
- `smooai-config` (Python)
- `smooai_config` (Rust)
- `github.com/smooai/config/go` (Go)

You can bake the bundle in any language and decrypt it in any other.

## Common errors

### `Public.X` / `Secrets.X` / `FeatureFlags.X` won't compile

The Roslyn source generator only emits typed key properties for keys declared in the `schema.json` file marked `SmooConfigSchema="true"` in your csproj. If a key compiles in TypeScript but doesn't appear here, the schema your .NET project sees is stale. Either:

1. Re-run your generator step (`smooai-config push` or equivalent) so `schema.json` picks up the new key, then rebuild — or
2. Add the key to your config schema in the source repo and regenerate.

A `dotnet build` after pulling latest is enough to refresh the generated keys.

### `SmooConfigRuntimeException: AES-GCM decryption failed`

The blob and key don't match. Check that `SMOO_CONFIG_KEY_FILE` points at the bundle baked with the key in `SMOO_CONFIG_KEY` — mismatched key/blob pairs surface as a tag-verification failure, which is what GCM is supposed to do. Re-bake the bundle and re-set both env vars together.

## Links

- **Homepage**: [smoo.ai](https://smoo.ai)
- **Source**: [github.com/SmooAI/config](https://github.com/SmooAI/config)
- **Issues**: [github.com/SmooAI/config/issues](https://github.com/SmooAI/config/issues)
- **License**: MIT
