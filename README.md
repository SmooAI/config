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

**Type-safe config, secrets, and feature flags for every layer of your stack** -- One schema, one API, every language. Rename a key and every call site is a compile error, not a 3 AM page.

![NPM Version](https://img.shields.io/npm/v/%40smooai%2Fconfig?style=for-the-badge)
![NPM Downloads](https://img.shields.io/npm/dw/%40smooai%2Fconfig?style=for-the-badge)
![NPM Last Update](https://img.shields.io/npm/last-update/%40smooai%2Fconfig?style=for-the-badge)

![GitHub License](https://img.shields.io/github/license/SmooAI/config?style=for-the-badge)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/SmooAI/config/release.yml?style=for-the-badge)
![GitHub Repo stars](https://img.shields.io/github/stars/SmooAI/config?style=for-the-badge)

---

### What you get

- **Three tiers, one schema** -- public config, secrets, and feature flags defined once with Zod/Valibot/ArkType/Effect, validated everywhere they're read.
- **Strongly-typed keys** -- `defineConfig()` gives you `PublicConfigKeys`, `SecretConfigKeys`, and `FeatureFlagKeys` with full inference. Mis-typed keys fail at compile time, not at runtime.
- **Any environment, any key** -- same API for `development`, `staging`, `production`. Override per-stage without touching code.
- **Zero-latency cold starts** -- values are baked into the bundle as env vars (Next.js, Vite) or resolved in-memory from a local runtime (server). No network round-trip on the hot path.
- **Browser, server, framework-native** -- the same typed keys read cleanly from React client components, Server Components, Next.js, Vite, or plain Node.
- **Live feature flags** -- toggled from the dashboard without a redeploy, but still typed.
- **Native clients in every language** -- TypeScript, Python, Rust, Go, .NET (C#) all read from the same source of truth.

---

### Languages / SDKs

Pick the SDK that matches your service. Every client reads the same schema, the same encrypted bundle, and the same config API — so a key renamed in one language ripples through all of them.

| SDK            | One-liner                                                                                               | README                                           |
| -------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **TypeScript** | Primary SDK. Schema definition, Next.js / Vite plugins, server runtime, React hooks.                    | [`README.md` (this file)](#about-smooaiconfig)   |
| **Python**     | Pydantic-validated schemas, sync `ConfigClient`, `LocalConfigManager` + `ConfigManager`, baked runtime. | [`python/README.md`](python/README.md)           |
| **Go**         | Native struct schemas, thread-safe `ConfigClient` / `ConfigManager`, baked-blob runtime.                | [`go/config/README.md`](go/config/README.md)     |
| **Rust**       | `JsonSchema`-derived schemas, async `ConfigClient`, sync `ConfigManager`, baked-blob runtime.           | [`rust/config/README.md`](rust/config/README.md) |
| **.NET**       | Roslyn source-generated typed keys, OAuth2 `SmooConfigClient`, AES-GCM `SmooConfigRuntime`.             | [`dotnet/README.md`](dotnet/README.md)           |

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

For Node.js server code, use `buildConfigObject` to get sync and async accessors with full type safety:

```typescript
import buildConfigObject from '@smooai/config/platform/server';
import config, { PublicConfigKeys, SecretConfigKeys, FeatureFlagKeys } from './.smooai-config/config';

const configObj = buildConfigObject(config);

// Sync access (uses worker threads)
const dbUrl = configObj.secretConfig.getSync(SecretConfigKeys.DATABASE_URL);
const apiUrl = configObj.publicConfig.getSync(PublicConfigKeys.API_BASE_URL);
const isNewUi = configObj.featureFlag.getSync(FeatureFlagKeys.ENABLE_NEW_UI);

// Async access
const apiKey = await configObj.secretConfig.getAsync(SecretConfigKeys.API_KEY);
```

### How `.getSync()` works (and how to ship it in any bundled compute)

Sync accessors run an async config read to completion on the caller thread via
[`synckit`](https://github.com/un-ts/synckit) — a Node `Worker` pool +
`Atomics.wait` on a `SharedArrayBuffer`. `createSyncFn` only accepts a
`file://` URL, so the worker body has to live on disk. The SDK resolves it in
two stages:

1. **Sidecar file** — `sync-worker.mjs` sitting next to the compiled SDK entry
   (i.e. resolved via `new URL('./sync-worker.mjs', import.meta.url)` from
   `dist/server/index.mjs`). This is the normal case for plain Node resolution
   with no bundling — `node_modules/@smooai/config/dist/server/sync-worker.mjs`
   is already there. It's also the preferred case when bundlers copy the
   sidecar into the deploy output. **Zero `/tmp` writes.**

2. **Extract-to-`/tmp` fallback** — if the sidecar isn't on disk at that path
   (e.g. a bundler inlined the SDK entry into a single file and didn't copy
   the sidecar), the SDK writes an embedded copy of the worker source to
   `mkdtempSync()/sync-worker.mjs` once per process and hands that path to
   synckit. One ~1-2 MiB write at cold start, amortised across every sync
   read for the lifetime of the process. Works anywhere with a writable temp
   dir.

Both paths are transparent — your code is identical either way. Which path
you land on depends on how your compute is packaged.

#### Plain Node (no bundling)

Zero config. The SDK resolves `node_modules/@smooai/config/dist/server/sync-worker.mjs`
directly — path (1) every time.

#### Any bundled compute (Lambda, Cloud Run, ECS, container, Worker, etc.)

The rule is universal: **if your build inlines the SDK entry into a single
output file, you need to ship `sync-worker.mjs` next to that output** (or accept
path (2)'s `/tmp` write once per cold start).

The source path is always:

```
node_modules/@smooai/config/dist/server/sync-worker.mjs
```

The destination is alongside whichever file ends up being your runtime's
`import.meta.url` anchor — typically the bundled handler `.mjs` / `.js`.

Recipes for common setups:

**esbuild — explicit copy plugin**

```ts
// build.ts
import { build } from 'esbuild';
import { copy } from 'esbuild-plugin-copy';

await build({
    entryPoints: ['src/handler.ts'],
    outdir: 'dist',
    bundle: true,
    format: 'esm',
    platform: 'node',
    plugins: [
        copy({
            assets: {
                from: 'node_modules/@smooai/config/dist/server/sync-worker.mjs',
                to: 'dist/sync-worker.mjs',
            },
        }),
    ],
});
```

**tsup — `onSuccess` hook**

```ts
// tsup.config.ts
export default defineConfig({
    entry: ['src/handler.ts'],
    format: ['esm'],
    onSuccess: 'cp node_modules/@smooai/config/dist/server/sync-worker.mjs dist/sync-worker.mjs',
});
```

**Serverless Framework — `package.include`**

```yaml
package:
    patterns:
        - 'node_modules/@smooai/config/dist/server/sync-worker.mjs'
```

Or copy into the handler dir as a build step and include from there.

**AWS SAM — `CodeUri` + build script**

Add a `Makefile` / build script that copies `sync-worker.mjs` into the
`BuildArtifactPath` alongside your handler.

**SST (AWS) — per-function or via `$transform`**

```typescript
// sst.config.ts — per function
new sst.aws.Function('Api', {
    handler: 'src/api.handler',
    copyFiles: [{ from: 'node_modules/@smooai/config/dist/server/sync-worker.mjs' }],
});

// Or at the stack level via $transform (every Function gets it automatically)
$transform(sst.aws.Function, (fn) => {
    fn.copyFiles = [...(fn.copyFiles ?? []), { from: 'node_modules/@smooai/config/dist/server/sync-worker.mjs' }];
});
```

**Docker container (ECS, Cloud Run, anywhere)**

```dockerfile
# After your main build step, ensure the sidecar is next to the bundled entry.
COPY --from=build /app/dist/server.mjs /app/
COPY --from=build /app/node_modules/@smooai/config/dist/server/sync-worker.mjs /app/
CMD ["node", "server.mjs"]
```

If your build step keeps `node_modules` in the final image, no extra copy is
needed — the SDK resolves the sidecar from `node_modules/` path (1) directly.

#### When the sidecar truly can't be shipped

Path (2) — the `/tmp` extraction — is the safety net. One ~1-2 MiB write at
cold start, then synckit re-uses the file for the rest of the process lifetime.
Lambda's 512 MiB–10 GiB `/tmp` easily absorbs this; containers with an ephemeral
`/tmp` work the same way. **You can ignore this whole section and `.getSync()`
will still work** — you're just paying one filesystem write per cold start.

#### Edge runtimes (Vercel Edge, Cloudflare Workers)

These runtimes don't expose Node's `worker_threads` at all, so `.getSync()` is
a no-go there by design. Use `.get()` (async) everywhere that needs to run on
the edge. The error surface makes this explicit if you try.

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

@smooai/config has native implementations in Python, Rust, Go, and .NET (C#) alongside the primary TypeScript package. Every client reads the same encrypted bundle, the same schema, and the same config API. See the per-SDK READMEs linked above for full usage docs — the snippets below are five-line orientation only.

### Python — see [`python/README.md`](python/README.md)

```sh
pip install smooai-config
# or: uv add smooai-config
```

```python
from smooai_config.client import ConfigClient

with ConfigClient() as client:  # reads SMOOAI_CONFIG_* env vars
    value = client.get_value("API_URL", environment="production")
```

### Rust — see [`rust/config/README.md`](rust/config/README.md)

```sh
cargo add smooai-config
```

```rust
use smooai_config::ConfigClient;

let mut client = ConfigClient::from_env();
let value = client.get_value("API_URL", None).await?;
```

### Go — see [`go/config/README.md`](go/config/README.md)

```sh
go get github.com/SmooAI/config/go/config
```

```go
import "github.com/SmooAI/config/go/config"

client := config.NewConfigClientFromEnv()
defer client.Close()
value, _ := client.GetValue("API_URL", "production")
```

### .NET — see [`dotnet/README.md`](dotnet/README.md)

```sh
dotnet add package SmooAI.Config
```

```csharp
using SmooAI.Config;
using SmooAI.Config.Runtime;

var runtime = SmooConfigRuntime.Load();  // reads SMOO_CONFIG_KEY_FILE + SMOO_CONFIG_KEY
using var client = new SmooConfigClient(options);
var apiUrl = await Public.ApiUrl.ResolveAsync(runtime, client);
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
