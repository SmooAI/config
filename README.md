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

**Type-safe configuration management for every layer of your stack** -- Define configuration schemas once, validate everywhere, and manage public settings, secrets, and feature flags with full TypeScript inference.

![NPM Version](https://img.shields.io/npm/v/%40smooai%2Fconfig?style=for-the-badge)
![NPM Downloads](https://img.shields.io/npm/dw/%40smooai%2Fconfig?style=for-the-badge)
![NPM Last Update](https://img.shields.io/npm/last-update/%40smooai%2Fconfig?style=for-the-badge)

![GitHub License](https://img.shields.io/github/license/SmooAI/config?style=for-the-badge)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/SmooAI/config/release.yml?style=for-the-badge)
![GitHub Repo stars](https://img.shields.io/github/stars/SmooAI/config?style=for-the-badge)

---

### What's New in v4 (Breaking)

- **`@smooai/config/server`** -- One unified backend SDK. Collapses the old `/platform/runtime` + `/platform/server` into a single `buildConfig(schema)` call that returns `{ publicConfig, secretConfig, featureFlag }` with `.get()` (async) and `.getSync()` (synckit-backed) per tier.
- **`@smooai/config/client`** -- Expanded to mirror the tier shape on the browser side: `buildClientConfig(schema)` exposes `publicConfig` + `featureFlag` (no `secretConfig` — enforced at the type level).
- **Four-source priority chain** -- A single call looks up values through four ordered sources (see the [Priority Chain](#priority-chain) section): baked blob → env vars → HTTP API → local file defaults.
- **Removed**: `/platform/runtime` (`buildConfigRuntime`, `readBakedConfig`, `hydrateConfigClient`), `/platform/server` (`buildConfigObject`). Use `/server` everywhere.
- **Kept internal**: `/platform/client` (`ConfigClient` class) and `/platform/build` (deploy-time baker). Both are used by the higher-level surfaces — you generally don't need to import them.
- **Language parity**: TypeScript is the reference implementation in v4. Python, Rust, and Go SDKs track the same priority chain and tier shape but ship on their own cadence — see [Multi-Language Support](#multi-language-support).

### What's New in v3

- **`@smooai/config/client`** -- Universal client reader for feature flags and public config. Works in Next.js, Vite, and any browser environment with zero Node.js dependencies.
- **`@smooai/config/nextjs/withSmooConfig`** -- Inject feature flags _and_ public config into `next.config.ts` as `NEXT_PUBLIC_` env vars. Replaces the deprecated `withFeatureFlags`.
- **`@smooai/config/feature-flags`** -- Build-time feature flag reader (re-exports from `/client` for convenience).
- **`@smooai/config/vite/smooConfigPlugin`** -- Vite plugin that injects `VITE_FEATURE_FLAG_*` and `VITE_CONFIG_*` at build time.
- **Browser/server separation** -- Browser builds ship zero Node.js deps. Every export path has a dedicated `browser` condition in `package.json`.
- **Typed key objects** -- `defineConfig()` returns `FeatureFlagKeys`, `PublicConfigKeys`, and `SecretConfigKeys` with auto-generated `UPPER_SNAKE_CASE` mappings and full TypeScript inference.

---

## Priority Chain

Whether you call `config.secretConfig.get('sendgridApiKey')` from a Lambda, `config.publicConfig.getSync('apiBaseUrl')` from a class constructor, or `featureFlag.get('newUi')` from a CLI script, the same **fallback chain** runs under the hood. It is identical across TypeScript, Python, Rust, and Go.

The chain is **not** a merge or an override stack — it's try-in-order-first-hit-wins. The moment a source has a value for the key, we return it and don't consult the rest. The HTTP API is only touched when both the blob and env lack the key; the local file is only touched when the first three are silent.

### Public + secret tiers

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    config.secretConfig.get('foo')                        │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │
                                     ▼
                         ┌─────────────────────┐
                         │ 1. BAKED BLOB       │  found? ─► return
                         │ AES-GCM on disk,    │
                         │ decrypted once at   │
                         │ cold start          │
                         └──────────┬──────────┘
                                    │ (empty)
                                    ▼
                         ┌─────────────────────┐
                         │ 2. ENV VAR          │  found? ─► return
                         │ process.env         │
                         │ [UPPER_SNAKE_CASE]  │
                         └──────────┬──────────┘
                                    │ (empty)
                                    ▼
                         ┌─────────────────────┐
                         │ 3. HTTP CONFIG API  │  found? ─► return
                         │ api.smoo.ai         │
                         │ (30s cache)         │
                         └──────────┬──────────┘
                                    │ (empty)
                                    ▼
                         ┌─────────────────────┐
                         │ 4. LOCAL FILE       │  found? ─► return
                         │ .smooai-config/     │
                         │ <env>.*  defaults   │
                         └──────────┬──────────┘
                                    │ (empty)
                                    ▼
                                undefined
```

**What each tier is for** (not "what overrides what" — every tier is just a source we try in order):

1. **Baked blob** — written onto the Lambda bundle by the deploy-time baker, encrypted at rest, decrypted once in memory at cold start. Prod Lambdas get every key they need from here, so resolving a config value in prod involves **zero network calls**. The blob is a snapshot of the config API as of the last deploy.
2. **Env vars** — `process.env[UPPER_SNAKE_CASE(key)]`. Useful when running outside a baked container: CI jobs, local shells (`SENDGRID_API_KEY=foo tsx ./script.ts`), ad-hoc tests. Can't override a value already in the blob — if you need that, invalidate the baker's cache and redeploy.
3. **HTTP config API** (`api.smoo.ai`) — the centralized source of truth. Fetched at runtime for keys the baker didn't include (e.g. a value added after the last deploy) and for non-Lambda processes that don't have a blob. Backed by `@smooai/fetch` with retries + Retry-After handling. Results cached in-process (30s for flags, indefinite for values until `invalidateCaches()`).
4. **Local file defaults** — values shipped in the repo under `.smooai-config/<env>.*`. These are baseline defaults every developer gets by checking out the code; no config API auth required, no network needed. Deep-merged with `default.*` as the always-loaded baseline.

If every tier is silent, the call resolves to `undefined` (or throws with a typed error when the strict flag is set).

### Feature flag tier

Feature flags flip the top of the chain — HTTP first — because they're **designed to change without a redeploy**. Blob is skipped entirely; no flag ever gets baked.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                config.featureFlag.get('newUi')                           │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │
                                     ▼
                         ┌─────────────────────┐
                         │ 1. HTTP CONFIG API  │  found? ─► return
                         │ api.smoo.ai         │
                         │ (30s cache)         │
                         └──────────┬──────────┘
                                    │ (empty)
                                    ▼
                         ┌─────────────────────┐
                         │ 2. ENV VAR          │  found? ─► return
                         │ process.env         │
                         └──────────┬──────────┘
                                    │ (empty)
                                    ▼
                         ┌─────────────────────┐
                         │ 3. LOCAL FILE       │  found? ─► return
                         │ .smooai-config/     │
                         │ <env>.*  defaults   │
                         └──────────┬──────────┘
                                    │ (empty)
                                    ▼
                                undefined
```

Putting HTTP at #1 with a 30-second cache means a flag toggle in the config UI propagates to every running process within that window — no redeploy. If the config server is unreachable, env vars and local-file defaults keep the app working. Blob is deliberately absent so flags stay live-toggleable by design.

### The `.smooai-config/` local file tier

This is the layer people miss most often. Your repo ships a `.smooai-config/` directory with per-environment files:

```
.smooai-config/
├── config.ts            # the schema — imported at build time + used for types
├── default.ts           # baseline values, loaded in every environment
├── development.ts       # dev overrides
├── staging.ts           # staging overrides
├── production.ts        # production overrides
├── production.aws.ts    # AWS-only production overrides
└── production.aws.us-east-2.ts   # region-specific overrides
```

Resolution is **deep-merged** in load order — `default.ts` → `<env>.ts` → `<env>.<cloud>.ts` → `<env>.<cloud>.<region>.ts`. This means you can:

- Ship sensible defaults in source (no one has to configure them)
- Override per-environment without duplicating
- Scope overrides to a cloud provider or a single region

**Picking which directory to read**: by default the SDK looks for `.smooai-config/` (or `smooai-config/`) starting at `process.cwd()` and walking up 5 levels. Override with `SMOOAI_ENV_CONFIG_DIR=<absolute-path>` if your binary lives somewhere unusual.

**Picking which environment file**: set `SMOOAI_CONFIG_ENV=<name>`. If the file doesn't exist, the SDK silently skips it — only `default.ts` is required.

### Frontend bundles (Next.js + Vite)

Browsers can't read the baked Lambda blob and shouldn't be handed a long-lived M2M secret for the HTTP API. The frontend chain is therefore shorter — same fallback semantics, just two sources:

```
┌──────────────────────────────────────────────────────────────────────────┐
│              config.publicConfig.getSync('apiBaseUrl')                   │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │
                                     ▼
                         ┌─────────────────────┐
                         │ 1. BUNDLE-BAKED     │  found? ─► return
                         │    ENV VAR          │
                         │ NEXT_PUBLIC_CONFIG_*│
                         │ VITE_CONFIG_*       │
                         └──────────┬──────────┘
                                    │ (empty; getSync returns undefined here
                                    │  — only `get` (async) continues)
                                    ▼
                         ┌─────────────────────┐
                         │ 2. HTTP CONFIG API  │  found? ─► return
                         │ api.smoo.ai         │
                         │ (B2M key,           │
                         │  public + flags     │
                         │  only)              │
                         └──────────┬──────────┘
                                    │ (empty)
                                    ▼
                                undefined
```

The bundler plugin (`withSmooConfig` for Next.js, `smooConfigPlugin` for Vite) reads `.smooai-config/` at build time and inlines the public values as `NEXT_PUBLIC_CONFIG_*` / `VITE_CONFIG_*`. At runtime, `buildClientConfig(schema)` reads those first; `get` (async) falls through to the HTTP API for any key that wasn't baked. `getSync` is bundle-only — there's no synckit on the browser side.

`secretConfig` is not exposed on `/client` at all — it's a compile-time error to try to read a secret in a browser bundle.

---

### Install

```sh
pnpm add @smooai/config
```

---

## Quick Start (TypeScript)

### 1. Define your configuration schema

Use `defineConfig()` with any [StandardSchema](https://github.com/standard-schema/standard-schema)-compliant library (Zod, Valibot, ArkType, Effect Schema) or the built-in `StringSchema`, `BooleanSchema`, and `NumberSchema` helpers:

```typescript
// .smooai-config/config.ts
import { defineConfig, StringSchema, BooleanSchema, NumberSchema } from '@smooai/config';
import { z } from 'zod';

const config = defineConfig({
    publicConfigSchema: {
        apiBaseUrl: z.string().url(),
        maxRetries: NumberSchema,
        enableDebug: BooleanSchema,
    },
    secretConfigSchema: {
        databaseUrl: z.string().url(),
        apiKey: StringSchema,
    },
    featureFlagSchema: {
        enableNewUi: BooleanSchema,
        betaFeatures: BooleanSchema,
    },
});

export default config;

// Extract typed key objects for use throughout your app
export const { FeatureFlagKeys, PublicConfigKeys, SecretConfigKeys } = config;
```

`defineConfig()` automatically maps camelCase keys to `UPPER_SNAKE_CASE`:

```typescript
FeatureFlagKeys.ENABLE_NEW_UI; // "ENABLE_NEW_UI"
PublicConfigKeys.API_BASE_URL; // "API_BASE_URL"
SecretConfigKeys.DATABASE_URL; // "DATABASE_URL"
```

### 2. Add to `tsconfig.json`

```json
{
    "compilerOptions": { ... },
    "include": ["src/**/*", ".smooai-config/**/*.ts"]
}
```

---

## Next.js Integration

### Inject config into `next.config.ts`

Use `withSmooConfig()` to inject feature flags and public config as `NEXT_PUBLIC_` environment variables, with per-stage overrides:

```typescript
// next.config.ts
import { withSmooConfig } from '@smooai/config/nextjs/withSmooConfig';

const nextConfig = withSmooConfig({
    default: {
        featureFlags: { enableNewUi: false, betaFeatures: false },
        publicConfig: { apiBaseUrl: 'https://api.smooai.com', maxRetries: 3 },
    },
    development: {
        featureFlags: { enableNewUi: true },
        publicConfig: { apiBaseUrl: 'http://localhost:3000' },
    },
});

export default nextConfig;
```

This sets environment variables like `NEXT_PUBLIC_FEATURE_FLAG_ENABLE_NEW_UI=true` and `NEXT_PUBLIC_CONFIG_API_BASE_URL=http://localhost:3000` based on the current stage.

### Read config in React client components

```tsx
import { getClientFeatureFlag, getClientPublicConfig } from '@smooai/config/client';

function MyComponent() {
    const isNewUi = getClientFeatureFlag('enableNewUi');
    const apiUrl = getClientPublicConfig('apiBaseUrl');

    if (!isNewUi) return <LegacyUI />;
    return <NewUI apiUrl={apiUrl} />;
}
```

These functions check `NEXT_PUBLIC_FEATURE_FLAG_*` and `NEXT_PUBLIC_CONFIG_*` env vars automatically -- no provider needed, no loading state.

### Server Components + Client hydration (zero loading flash)

For apps that need runtime config from a config server, use `getConfig` on the server and `SmooConfigProvider` to hydrate client components:

```tsx
// app/layout.tsx (Server Component)
import { getConfig, SmooConfigProvider } from '@smooai/config/nextjs';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
    const config = await getConfig({
        environment: 'production',
        fetchOptions: { next: { revalidate: 60 } },
    });

    return (
        <html>
            <body>
                <SmooConfigProvider
                    initialValues={config}
                    baseUrl={process.env.SMOOAI_CONFIG_API_URL}
                    apiKey={process.env.SMOOAI_CONFIG_API_KEY}
                    orgId={process.env.SMOOAI_CONFIG_ORG_ID}
                    environment="production"
                >
                    {children}
                </SmooConfigProvider>
            </body>
        </html>
    );
}
```

```tsx
// Any client component -- values available synchronously (pre-seeded from SSR)
import { usePublicConfig, useFeatureFlag } from '@smooai/config/nextjs';

function Dashboard() {
    const { value: apiUrl } = usePublicConfig<string>('API_BASE_URL');
    const { value: enableNewUi } = useFeatureFlag<boolean>('ENABLE_NEW_UI');
    return (
        <div>
            API: {apiUrl}, New UI: {String(enableNewUi)}
        </div>
    );
}
```

---

## Vite Integration

### Vite plugin

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { smooConfigPlugin } from '@smooai/config/vite/smooConfigPlugin';

export default defineConfig({
    plugins: [
        smooConfigPlugin({
            featureFlags: { enableNewUi: true, betaFeatures: false },
            publicConfig: { apiBaseUrl: 'http://localhost:3000' },
        }),
    ],
});
```

Then read values the same way as Next.js -- `getClientFeatureFlag` and `getClientPublicConfig` from `@smooai/config/client` check `VITE_FEATURE_FLAG_*` and `VITE_CONFIG_*` automatically.

### Preload config (optional)

For runtime config from a config server, start fetching before React mounts:

```tsx
// main.tsx
import { preloadConfig, ConfigProvider } from '@smooai/config/vite';
import { createRoot } from 'react-dom/client';

preloadConfig({ environment: 'production' });

createRoot(document.getElementById('root')!).render(
    <ConfigProvider baseUrl="https://config.smooai.dev" apiKey="your-public-key" orgId="your-org-id" environment="production">
        <App />
    </ConfigProvider>,
);
```

---

## Server-Side Config Access

For Node.js server code (Lambda, long-running servers, CLI scripts), use `@smooai/config/server`. One import, one schema, typed tiers, and both async + sync accessors:

```typescript
import { buildConfig } from '@smooai/config/server';
import config, { PublicConfigKeys, SecretConfigKeys, FeatureFlagKeys } from './.smooai-config/config';

const cfg = buildConfig(config);

// Async (idiomatic in handlers):
const apiKey = await cfg.secretConfig.get(SecretConfigKeys.API_KEY);
const apiUrl = await cfg.publicConfig.get(PublicConfigKeys.API_BASE_URL);
const enabled = await cfg.featureFlag.get(FeatureFlagKeys.ENABLE_NEW_UI);

// Sync (drop-in for class constructors and top-level module init — uses synckit):
const dbUrl = cfg.secretConfig.getSync(SecretConfigKeys.DATABASE_URL);
```

Every call runs the full [priority chain](#priority-chain) (baked blob → env → HTTP → file). Values memoize in-process, and feature flags auto-refresh on a 30-second cache TTL.

**Diagnostics**: `cfg.getSource('apiKey')` returns `'blob' | 'env' | 'http' | 'file' | undefined` to tell you which tier served the last read — useful in tests and canaries.

**Singleton pattern**: in a monorepo, wrap `buildConfig(schema)` behind a `smooConfig()` helper once and import that helper everywhere. This keeps all consumers sharing one set of caches + one pool of synckit workers.

---

## React Hooks (framework-agnostic)

For any React app using the runtime config client:

```tsx
import { ConfigProvider, usePublicConfig, useFeatureFlag } from '@smooai/config/react';

function App() {
    return (
        <ConfigProvider baseUrl="https://config.smooai.dev" apiKey="your-api-key" orgId="your-org-id" environment="production">
            <MyComponent />
        </ConfigProvider>
    );
}

function MyComponent() {
    const { value: apiUrl, isLoading, error } = usePublicConfig<string>('API_BASE_URL');
    const { value: enableNewUi } = useFeatureFlag<boolean>('ENABLE_NEW_UI');

    if (isLoading) return <div>Loading...</div>;
    if (error) return <div>Error: {error.message}</div>;

    return (
        <div>
            API URL: {apiUrl}, New UI: {String(enableNewUi)}
        </div>
    );
}
```

---

## SDK Runtime Client

All language implementations include a runtime client for fetching configuration values from the Smoo AI config server with local caching.

### Environment Variables

| Variable                | Description                                            | Required |
| ----------------------- | ------------------------------------------------------ | -------- |
| `SMOOAI_CONFIG_API_URL` | Base URL of the config API                             | Yes      |
| `SMOOAI_CONFIG_API_KEY` | Bearer token for authentication                        | Yes      |
| `SMOOAI_CONFIG_ORG_ID`  | Organization ID                                        | Yes      |
| `SMOOAI_CONFIG_ENV`     | Default environment name (defaults to `"development"`) | No       |

### TypeScript Client

```typescript
import { ConfigClient } from '@smooai/config/platform/client';

// Zero-config (reads from env vars)
const client = new ConfigClient();

// Or explicit
const client = new ConfigClient({
    baseUrl: 'https://config.smooai.dev',
    apiKey: 'your-api-key',
    orgId: 'your-org-id',
    environment: 'production',
});

const apiUrl = await client.getValue('API_BASE_URL');
const allValues = await client.getAllValues();
client.invalidateCache();
```

---

## Configuration Tiers

| Tier              | Purpose                 | Examples                                 |
| ----------------- | ----------------------- | ---------------------------------------- |
| **Public**        | Client-visible settings | API URLs, feature toggles, UI config     |
| **Secret**        | Server-side only        | Database URLs, API keys, JWT secrets     |
| **Feature Flags** | Runtime toggles         | A/B tests, gradual rollouts, beta access |

### Security: B2M Key Restrictions

| Operation            | B2M (Public Key)  | M2M (Secret Key) |
| -------------------- | ----------------- | ---------------- |
| Read public values   | Yes               | Yes              |
| Read feature flags   | Yes               | Yes              |
| Read secret values   | **No** (filtered) | Yes              |
| Write config values  | **No** (403)      | Yes              |
| Delete config values | **No** (403)      | Yes              |

**Browser-to-Machine (B2M)** keys are designed for browser clients. Secret-tier values are automatically filtered. B2M keys are read-only for public and feature flag tiers.

**Machine-to-Machine (M2M)** keys have full access to all tiers and write operations.

---

## Multi-Language Support

@smooai/config has native implementations in Python, Rust, and Go alongside the primary TypeScript package. **All four implementations share the same conceptual [priority chain](#priority-chain)** — baked blob → env vars → HTTP API → local file defaults (flags skip blob). The public API shape is uniform, with language-idiomatic adjustments:

| Language   | Unified accessor       | Sync                         | Async              | Parity status                             |
| ---------- | ---------------------- | ---------------------------- | ------------------ | ----------------------------------------- |
| TypeScript | `buildConfig(schema)`  | `.getSync()` (synckit)       | `.get()`           | ✅ v4 reference implementation            |
| Python     | `build_config(schema)` | `.get_sync()`                | `.get()` (asyncio) | 🚧 tracking — see `python/README.md`      |
| Rust       | `build_config(schema)` | `.get_blocking()` (block_on) | `.get()` (tokio)   | 🚧 tracking — see `rust/config/README.md` |
| Go         | `BuildConfig(schema)`  | `.Get(ctx)` (context-based)  | —                  | 🚧 tracking — see `go/config/README.md`   |

Each language's README explains the language-specific call patterns + current parity status. The `@smooai/fetch` (or equivalent) is used for HTTP-tier calls in every language.

### Python

```sh
pip install smooai-config
# or: uv add smooai-config
```

```python
from pydantic import BaseModel
from smooai_config import define_config
from smooai_config.client import ConfigClient

class PublicConfig(BaseModel):
    api_url: str = "https://api.example.com"
    max_retries: int = 3

class SecretConfig(BaseModel):
    database_url: str
    api_key: str

config = define_config(public=PublicConfig, secret=SecretConfig)

with ConfigClient() as client:  # reads from env vars
    value = client.get_value("API_URL", environment="production")
    all_values = client.get_all_values()
```

### Rust

```toml
[dependencies]
smooai-config = { git = "https://github.com/SmooAI/config", package = "smooai-config" }
```

```rust
use smooai_config::client::ConfigClient;

let mut client = ConfigClient::from_env();
let value = client.get_value("API_URL", None).await?;
let all = client.get_all_values(Some("production")).await?;
```

### Go

```sh
go get github.com/SmooAI/config/go/config
```

```go
import "github.com/SmooAI/config/go/config"

client := config.NewConfigClientFromEnv()
defer client.Close()

value, err := client.GetValue("API_URL", "production")
allValues, err := client.GetAllValues("")
```

---

## Development

### Prerequisites

- Node.js 22+, pnpm 10+
- Python 3.13+ with uv (for Python package)
- Rust toolchain (for Rust package)
- Go 1.22+ (for Go package)

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

### Schema Libraries

Supports Zod, Valibot, ArkType, Effect Schema, and built-in schema types. See [SCHEMA_USAGE.md](SCHEMA_USAGE.md) for examples with each library.

---

## Contributing

Contributions are welcome! This project uses [changesets](https://github.com/changesets/changesets) to manage versions and releases.

1. Fork the repository
2. Create your branch (`git checkout -b amazing-feature`)
3. Make your changes
4. Add a changeset: `pnpm changeset`
5. Commit and push
6. Open a Pull Request

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
