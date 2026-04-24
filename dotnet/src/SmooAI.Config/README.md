# SmooAI.Config

.NET client for the [Smoo AI](https://smoo.ai) config platform. Reads and writes
typed configuration values and secrets using OAuth2 client-credentials auth.

## Installation

```sh
dotnet add package SmooAI.Config
```

## Usage

```csharp
using SmooAI.Config;
using SmooAI.Config.Models;

var client = new SmooConfigClient(new SmooConfigClientOptions
{
    ClientId     = Environment.GetEnvironmentVariable("SMOOAI_CLIENT_ID")!,
    ClientSecret = Environment.GetEnvironmentVariable("SMOOAI_CLIENT_SECRET")!,
    OrgId        = Environment.GetEnvironmentVariable("SMOOAI_ORG_ID")!,
    BaseUrl      = "https://api.smoo.ai",          // optional, default
    DefaultEnvironment = "production",              // optional, default
});

// Read a single value
var value = await client.GetValueAsync("moonshotApiKey");

// Read every value in an environment
var all = await client.GetAllValuesAsync();

// Write a value (requires schemaId + environmentId from the API)
await client.SetValueAsync(
    schemaId:      "uuid...",
    environmentId: "uuid...",
    key:           "moonshotApiKey",
    value:         "sk-...",
    tier:          ConfigTier.Secret);
```

## Auth

- OAuth2 client-credentials exchange against `{baseUrl}/token` after rewriting
  `api.` → `auth.` (so `api.smoo.ai` → `auth.smoo.ai`). Override via
  `SmooConfigClientOptions.AuthUrl` if needed.
- Tokens are cached in memory and refreshed 60 seconds before expiry.
- On a 401 response the client invalidates its cached token and retries once.

## Scope

Phase 1: HTTP client + OAuth. The cohort-aware feature-flag evaluator and
buildBundle / buildConfigRuntime helpers land in later phases.

## License

MIT
