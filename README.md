<p align="center">
  <a href="https://smoo.ai"><img src=".github/banner.png" alt="@smooai/config — One schema. Every language. Typed everywhere." width="100%" /></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@smooai/config"><img src="https://img.shields.io/npm/v/@smooai/config?style=for-the-badge&color=00A6A6&label=npm&logo=npm&logoColor=white&labelColor=020618" alt="npm"></a>
  <a href="https://smoo.ai"><img src="https://img.shields.io/badge/Smoo_AI-platform-00A6A6?style=for-the-badge&labelColor=020618" alt="Smoo AI"></a>
  <img src="https://img.shields.io/badge/license-MIT-F49F0A?style=for-the-badge&labelColor=020618" alt="license">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Python-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python">
  <img src="https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white" alt="Rust">
  <img src="https://img.shields.io/badge/Go-00ADD8?style=flat-square&logo=go&logoColor=white" alt="Go">
  <img src="https://img.shields.io/badge/.NET-512BD4?style=flat-square&logo=dotnet&logoColor=white" alt=".NET">
</p>

<p align="center">
  <a href="#-features"><b>Features</b></a> &nbsp;·&nbsp;
  <a href="#-install"><b>Install</b></a> &nbsp;·&nbsp;
  <a href="#-quick-start-typescript"><b>Quick start</b></a> &nbsp;·&nbsp;
  <a href="#-part-of-smoo-ai"><b>Platform</b></a>
</p>

---

> Define your config once with Zod (or Valibot, ArkType, Effect), and read it with full type inference everywhere — public config, server-only secrets, and live feature flags. Rename a key and every call site is a compile error, not a 3 AM page. Native clients in TypeScript, Python, Rust, Go, and .NET all read from the same source of truth.

> 📣 **The CLI moved.** Use `th config` from the [smooth repo](https://github.com/SmooAI/smooth) for all operator commands (login, get, set, list, push, pull, diff, init, etc.). The standalone `smooai-config` CLI that used to live in this repo is deprecated and being deleted (SMOODEV-1411). **The runtime library `@smooai/config` (TypeScript / Python / Rust / Go / .NET, consumed via `secretConfig.get(...)` / `publicConfig.get(...)` / `featureFlag.get(...)`) is unchanged** — only the operator CLI surface moved to Rust in the smooth repo.

## ✨ Features

- **Three tiers, one schema** — public config, secrets, and feature flags defined once with Zod/Valibot/ArkType/Effect, validated everywhere they're read.
- **Strongly-typed keys** — `defineConfig()` gives you `PublicConfigKeys`, `SecretConfigKeys`, and `FeatureFlagKeys` with full inference. Mis-typed keys fail at compile time, not at runtime.
- **Any environment, any key** — the same API for `development`, `staging`, and `production`. Override per-stage without touching code.
- **Zero-latency cold starts** — values are baked into the bundle as env vars (Next.js, Vite) or resolved in-memory from a local runtime (server). No network round-trip on the hot path.
- **Browser, server, framework-native** — the same typed keys read cleanly from React client components, Server Components, Next.js, Vite, or plain Node.
- **Live feature flags** — toggled from the dashboard without a redeploy, but still typed.
- **Native clients in every language** — TypeScript, Python, Rust, Go, and .NET (C#) all read from the same source of truth.

## Languages / SDKs

Pick the SDK that matches your service. Every client reads the same schema, the same encrypted bundle, and the same config API — so a key renamed in one language ripples through all of them.

| SDK            | One-liner                                                                                               | README                                              |
| -------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **TypeScript** | Primary SDK. Schema definition, Next.js / Vite plugins, server runtime, React hooks.                    | [`README.md` (this file)](#-quick-start-typescript) |
| **Python**     | Pydantic-validated schemas, sync `ConfigClient`, `LocalConfigManager` + `ConfigManager`, baked runtime. | [`python/README.md`](python/README.md)              |
| **Go**         | Native struct schemas, thread-safe `ConfigClient` / `ConfigManager`, baked-blob runtime.                | [`go/config/README.md`](go/config/README.md)        |
| **Rust**       | `JsonSchema`-derived schemas, async `ConfigClient`, sync `ConfigManager`, baked-blob runtime.           | [`rust/config/README.md`](rust/config/README.md)    |
| **.NET**       | Roslyn source-generated typed keys, OAuth2 `SmooConfigClient`, AES-GCM `SmooConfigRuntime`.             | [`dotnet/README.md`](dotnet/README.md)              |

## 📦 Install

```sh
pnpm add @smooai/config
```

## 🚀 Quick Start (TypeScript)

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

## 📖 Next.js Integration

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

These functions check `NEXT_PUBLIC_FEATURE_FLAG_*` and `NEXT_PUBLIC_CONFIG_*` env vars automatically — no provider needed, no loading state.

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
// Any client component — values available synchronously (pre-seeded from SSR)
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

## 📖 Vite Integration

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

Then read values the same way as Next.js — `getClientFeatureFlag` and `getClientPublicConfig` from `@smooai/config/client` check `VITE_FEATURE_FLAG_*` and `VITE_CONFIG_*` automatically.

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

## 📖 Server-Side Config Access

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

## 📖 React Hooks (framework-agnostic)

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

## 📖 SDK Runtime Client

All language implementations include a runtime client for fetching configuration values from the Smoo AI config server with local caching.

### Environment Variables

Authentication is OAuth2 `client_credentials` against `{authUrl}/token` — the client exchanges `(CLIENT_ID, CLIENT_SECRET)` for a JWT and uses that JWT as the Bearer token on every config call. `TokenProvider` caches the JWT in memory and refreshes 60s before expiry.

| Variable                      | Description                                                                    | Required |
| ----------------------------- | ------------------------------------------------------------------------------ | -------- |
| `SMOOAI_CONFIG_API_URL`       | Base URL of the config API                                                     | Yes      |
| `SMOOAI_CONFIG_AUTH_URL`      | OAuth issuer base URL (defaults to `https://auth.smoo.ai`)                     | No       |
| `SMOOAI_CONFIG_CLIENT_ID`     | OAuth client ID                                                                | Yes      |
| `SMOOAI_CONFIG_CLIENT_SECRET` | OAuth client secret (legacy `SMOOAI_CONFIG_API_KEY` is accepted as a fallback) | Yes      |
| `SMOOAI_CONFIG_ORG_ID`        | Organization ID                                                                | Yes      |
| `SMOOAI_CONFIG_ENV`           | Default environment name (defaults to `"development"`)                         | No       |

> **Migration note (v5 / SMOODEV-974):** the TypeScript `ConfigClient` previously sent `SMOOAI_CONFIG_API_KEY` directly as the Bearer token, which the backend rejected with 401 because it expects a JWT. The SDK now mints a JWT via the OAuth `client_credentials` grant before each call — matching the .NET client, the in-package `bootstrap`, and the CLI. **You must set `SMOOAI_CONFIG_CLIENT_ID` in addition to `SMOOAI_CONFIG_API_KEY` / `SMOOAI_CONFIG_CLIENT_SECRET`** for the runtime SDK to work. The legacy `SMOOAI_CONFIG_API_KEY` env var continues to function as the OAuth client secret.

### TypeScript Client

```typescript
import { ConfigClient } from '@smooai/config/platform/client';

// Zero-config (reads from env vars — needs CLIENT_ID + CLIENT_SECRET/API_KEY + ORG_ID)
const client = new ConfigClient();

// Or explicit
const client = new ConfigClient({
    baseUrl: 'https://config.smooai.dev',
    authUrl: 'https://auth.smooai.dev',
    clientId: 'your-client-id',
    clientSecret: 'your-client-secret',
    orgId: 'your-org-id',
    environment: 'production',
});

const apiUrl = await client.getValue('API_BASE_URL');
const allValues = await client.getAllValues();
client.invalidateCache();
```

## 📖 Container / Runtime Mode (EKS / ECS)

The baked **blob** tier is the blessed path for **Lambda**, but it is the wrong default for long-lived **containers**: when the per-build blob key isn't delivered to the pod, resolution silently falls through to the (absent) file tier and returns `undefined` for a required secret. That caused a real outage — a container got `undefined` for `STRIPE_API_KEY`, `new Stripe(undefined)` threw at module load, the process exited `0` before `listen()`, and the pod CrashLooped with the root cause buried (SMOODEV-1478).

**Container mode** makes the HTTP config API the first-class path for containers, authenticated with an OAuth2 `client_credentials` (M2M) token, and **fails loud**: a required value that doesn't resolve throws a typed error instead of returning `undefined`.

> **Containers use container mode, not the baked blob.** See [`docs/Container-Runtime-Mode.md`](docs/Container-Runtime-Mode.md) for the full env contract, a complete ExternalSecret (External Secrets Operator) recipe, and a readiness-probe example.

```ts
import { initContainerConfig, ConfigKeyUnresolvedError } from '@smooai/config/container';
import schema from '../.smooai-config/config';

// Validates the container env, mints a token, and does an initial fetch —
// startup fails LOUD here (throws), not on first read.
const config = await initContainerConfig({ schema });

// Fail-loud: a required secret that doesn't resolve throws
// ConfigKeyUnresolvedError instead of returning undefined.
const stripeKey = await config.secretConfig.get('stripeApiKey');

// Kubernetes readiness probe — never throws.
app.get('/healthz/config', (_req, res) => {
    const h = config.health(); // { status: 'healthy' } | { status: 'unhealthy', reason }
    res.status(h.status === 'healthy' ? 200 : 503).json(h);
});
```

Env contract (identical in every SDK): `SMOOAI_CONFIG_API_URL`, `SMOOAI_CONFIG_CLIENT_ID`, `SMOOAI_CONFIG_CLIENT_SECRET`, `SMOOAI_CONFIG_ORG_ID`, `SMOOAI_CONFIG_ENV` (all required), plus optional `SMOOAI_CONFIG_AUTH_URL` and `SMOOAI_CONFIG_MODE=container` (to force the mode). All schema-declared keys are treated as **required** by default; opt specific keys out with `initContainerConfig({ optionalKeys: ['...'] })`.

## 📖 Configuration Tiers

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

## 📖 Multi-Language Support

`@smooai/config` has native implementations in Python, Rust, Go, and .NET (C#) alongside the primary TypeScript package. Every client reads the same encrypted bundle, the same schema, and the same config API. See the per-SDK READMEs linked above for full usage docs — the snippets below are five-line orientation only.

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

## 📖 Development

### Prerequisites

- Node.js 22+, pnpm 10+
- Python 3.13+ with uv (for the Python package)
- Rust toolchain (for the Rust package)
- Go 1.22+ (for the Go package)

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

## 🧩 Part of Smoo AI

`@smooai/config` is built and open-sourced by **[Smoo AI](https://smoo.ai)** — the AI-powered business platform with AI built into every product: CRM, customer support, campaigns, field service, observability, and developer tools.

- 🚀 **Config on the platform** — [smoo.ai/platform/config](https://smoo.ai/platform/config)
- 🧰 **More open source from Smoo AI** — [smoo.ai/open-source](https://smoo.ai/open-source)
- 🧩 **Sibling packages** — [@smooai/logger](https://github.com/SmooAI/logger), [@smooai/fetch](https://github.com/SmooAI/fetch), [@smooai/config-typescript](https://github.com/SmooAI/config-typescript), [smooth](https://github.com/SmooAI/smooth) (home of the `th config` CLI)

## 🤝 Contributing

Contributions are welcome. This project uses [changesets](https://github.com/changesets/changesets) to manage versions and releases.

1. Fork the repository.
2. Create your branch (`git checkout -b amazing-feature`).
3. Make your changes.
4. Add a changeset: `pnpm changeset`.
5. Commit and push.
6. Open a pull request.

## 📄 License

MIT © SmooAI. See [LICENSE](LICENSE).

## Contact

Brent Rager

- [Email](mailto:brent@smoo.ai)
- [LinkedIn](https://www.linkedin.com/in/brentrager/)
- [BlueSky](https://bsky.app/profile/brentragertech.bsky.social)
- [TikTok](https://www.tiktok.com/@brentragertech)
- [Instagram](https://www.instagram.com/brentragertech/)

Smoo GitHub: [github.com/SmooAI](https://github.com/SmooAI)

---

<p align="center">
  Built by <a href="https://smoo.ai"><strong>Smoo AI</strong></a> — AI built into every product.
</p>
