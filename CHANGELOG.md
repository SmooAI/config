# @smooai/library-template

## 4.7.2

### Patch Changes

- 0feca59: SMOODEV-958: Python/Rust/Go config managers now surface a friendly, actionable error when a caller asks for a config key that isn't declared in the schema — matching the TypeScript `assertKeyDefined` and .NET `ConfigKey` ctor behaviour added in SMOODEV-841. The most common cause is reading a `SecretConfigKeys.<X>` / `PublicConfigKeys.<X>` / `FeatureFlagKeys.<X>` constant for a key that isn't in `.smooai-config/config.ts`; previously the manager silently returned `None`/`nil`, masking the bug.

    Opt in via `strict_schema_keys=True` / `WithStrictSchemaKeys(true)` / `with_strict_schema_keys(true)` — off by default to preserve back-compat (the existing `schema_keys` set has historically also served as an env-var filter). New `UndefinedKeyError` (Python), `*UndefinedKeyError` (Go), and `SmooaiConfigErrorKind::UndefinedKey` (Rust) types let callers programmatically catch and handle the case.

- 60f173d: SMOODEV-960: Add a "CLI is TS-only — install via Node" note to each per-language README (Python, Rust, Go, .NET). The `smooai-config` CLI (push / pull / list / set / diff / login) is TypeScript-only by design because the schema is authored in TS, but a Python/Rust/Go/.NET-only team installing the SDK had no docs hint that they still needed Node for the CLI. Pure docs change.

## 4.7.1

### Patch Changes

- c3bc427: SMOODEV-928: Bump `@smooai/logger` to `^4.1.4`, `@smooai/utils` to `^1.3.3`, and `@smooai/fetch` to `^3.3.5`. Picks up the ESM `__filename` TDZ fix from logger 4.1.4 across the runtime dep graph (utils 1.3.2 and fetch 3.3.4 both still pulled logger 3.x as their own runtime deps).

## 4.7.0

### Minor Changes

- c4eb999: SMOODEV-880: Add `@smooai/config/bootstrap` cold-start fetch helper across all five SDKs

    Adds a lightweight, dependency-free entry point for reading a single config value
    via plain HTTP — OAuth `client_credentials` exchange + `GET /organizations/{orgId}/config/values`
    with per-process per-env caching. Designed for deploy scripts, container entry-points,
    and other cold-start contexts where importing the full SDK is too heavy or pulls in
    a transitive dependency that breaks the host runtime.

    Public surface per language:
    - **TypeScript**: `import { bootstrapFetch } from '@smooai/config/bootstrap'` — `bootstrapFetch(key, { environment? })`
    - **Python**: `from smooai_config.bootstrap import bootstrap_fetch` — `bootstrap_fetch(key, environment=None)`
    - **Go**: `import ".../go/config/bootstrap"` — `bootstrap.Fetch(ctx, key, bootstrap.WithEnvironment(...))`
    - **Rust**: `use smooai_config::bootstrap_fetch` — `bootstrap_fetch(key, environment).await`
    - **.NET**: `using SmooAI.Config.Bootstrap` — `Bootstrap.FetchAsync(key, new BootstrapOptions { Environment = ... })`

    Each implementation reads creds from `SMOOAI_CONFIG_{API_URL,AUTH_URL,CLIENT_ID,CLIENT_SECRET,ORG_ID}`
    (legacy `SMOOAI_CONFIG_API_KEY` and `SMOOAI_AUTH_URL` accepted), auto-detects the
    environment from `SST_STAGE` / `NEXT_PUBLIC_SST_STAGE` / `SST_RESOURCE_App` JSON /
    `SMOOAI_CONFIG_ENV`, and caches the values map per-env so repeated reads in the
    same process avoid the round-trip. None of the implementations import anything else
    from the SDK or pull in non-stdlib dependencies beyond what the crate/package already requires.

## 4.6.0

### Minor Changes

- 5e8bcf3: Throw a clear error when `secretConfig.get()` / `publicConfig.get()` /
  `featureFlag.get()` (or their `getSync` siblings) receive `undefined` /
  `null` / non-string keys, instead of cascading into `envVarNameFor`'s
  `undefined.replace(...)` and surfacing as the cryptic
  `Cannot read properties of undefined (reading 'replace')`.

    Most common cause: reading `SecretConfigKeys.<X>` (or
    `PublicConfigKeys.<X>` / `FeatureFlagKeys.<X>`) for a key that wasn't
    declared in the consumer's schema. The new error spells that out and
    points at `smooai-config push`. Cost real prod debug time on
    SMOODEV-841 — the route handler crashed deep inside `@smooai/config`'s
    internals while the actual fix was one declaration in
    `.smooai-config/config.ts`.

- 48aeee6: withSmooConfig: also wire `__SMOO_CLIENT_ENV__` through `nextConfig.compiler.define`

    `compiler.define` is Next.js 16's native compile-time replacement — it works for
    both webpack and turbopack out of the box with the same code-fragment semantics
    as webpack's DefinePlugin. Adding it alongside the existing DefinePlugin call
    means consumers no longer need `next dev --webpack` (or `next build --webpack`)
    to make `getClientPublicConfig(...)` / `getClientFeatureFlag(...)` resolve.

    Webpack DefinePlugin path is preserved as defense-in-depth so older Next.js
    versions and webpack-only pipelines keep working.

## 4.5.4

### Patch Changes

- e87ed1a: Add priority-chain integration tests across Python, Go, Rust, and .NET so each language has parity coverage with TypeScript's `server.priority-chain.integration.test.ts`. Test-only — no source changes.

    Documentation: per-SDK READMEs now cover the baked-runtime path (`SMOO_CONFIG_KEY_FILE` / `SMOO_CONFIG_KEY` env-var contract), have a Common errors section calling out the SMOODEV-847 schema-not-declared case, and the top-level README has a new Languages / SDKs section linking to each SDK's README. Added `dotnet/README.md` as the repo-level .NET entry point.

## 4.5.3

### Patch Changes

- ef89df0: SMOODEV-671: CLI push emits proper tiered JSON Schema for server-side storage

    `defineConfig()` now exposes `serializedAllConfigSchemaJsonSchema` — a full JSON Schema document with `publicConfigSchema` / `secretConfigSchema` / `featureFlagSchema` tier nodes and per-key `{type: 'string' | 'boolean' | 'number'}` (or full JSON Schema for zod/valibot/effect fields). This is the wire format the /apps/config dashboard expects.

    `smooai-config push` prefers this new property when available and falls back to the existing flat `serializedAllConfigSchema` (legacy configs) so pushes from older consumers keep working. The flat export is unchanged, so local runtime, buildBundle, and source generators are unaffected.

## 4.5.2

### Patch Changes

- 59da380: SMOODEV-666: Multi-target the SmooAI.Config NuGet package to `net8.0;net9.0;net10.0` so consumers on every current .NET LTS + STS release get a native framework match. The Roslyn source generator stays at `netstandard2.0` (required by the Roslyn host).

## 4.5.1

### Patch Changes

- 0fe4ae8: SMOODEV-664: Rewrite READMEs to value-frame the package — lead with strongly-typed config/secrets/feature flags, cross-language parity, and zero-latency cold starts. Move HTTP/OAuth/AES-GCM protocol detail to an "Under the hood" section so the first scroll sells the outcome, not the plumbing. Applies to the npm, NuGet, PyPI, crates.io, and Go docs.

## 4.5.0

### Minor Changes

- 759e60e: SmooAI.Config .NET phase 2: ship full parity with the TypeScript, Python, Rust, and Go clients.
    - **Local runtime** (`SmooConfigRuntime`) — AES-256-GCM decrypt of a baked bundle from `SMOO_CONFIG_KEY_FILE` + `SMOO_CONFIG_KEY`. Wire-compatible with every other language client (12-byte nonce || ciphertext || 16-byte tag). Thread-safe lazy singleton with env-var fallback for local dev.
    - **Build pipeline** (`SmooConfigBuilder.BuildAsync`) — fetches all values via the HTTP client, partitions public/secret via a `Classify` delegate (feature flags skipped), emits an encrypted bundle + base64 AES key. `SchemaClassifier.FromSchemaFile` reads a `schema.json` (JSON-Schema shape or serialized `defineConfig` shape).
    - **Roslyn source generator** — reads a `schema.json` from the consumer's `AdditionalFiles` and emits strongly-typed `Public.*`, `Secrets.*`, `FeatureFlags.*` static `ConfigKey<T>` properties under `SmooAI.Config.Generated`. Shipped inside the main `SmooAI.Config` NuGet — one package install, compile-time-safe key access.
    - **Typed key API** (`ConfigKey<T>`) — `.GetAsync(client)`, `.Get(runtime)`, `.ResolveAsync(runtime, client)`. Runtime-baked values resolve synchronously; missing keys fall through to the HTTP client.
    - **Great NuGet README** — rewritten with quickstart, feature overview, and wire-compat notes. Renders on nuget.org.
    - **Version sync** — `scripts/sync-versions.mjs` now bumps the `.csproj` to the npm version on every Changesets release; the Release workflow publishes to NuGet alongside PyPI/crates.io/Go. NuGet version aligns with the npm version (first synced release: 4.4.0).

### Patch Changes

- ba8fae8: SMOODEV-657: Add SmooAI.Config .NET (C#) client — phase 1

    New `dotnet/` folder with a `SmooAI.Config` NuGet package (net8.0) providing the
    HTTP client surface + OAuth2 client-credentials exchange that matches the TS,
    Rust, and Go clients. Published to nuget.org via the `publish-nuget.yml`
    workflow triggered by `dotnet-v*` tags. Cohort-aware evaluator and
    `buildBundle` / `buildConfigRuntime` helpers will land in a follow-up phase.

## 4.4.0

### Minor Changes

- 4a065ee: SMOODEV-643: CLI glowup — `smooai-config` now authenticates via OAuth2 client-credentials (auto-refreshing access tokens), loads TypeScript configs through `jiti` so explicit `ReturnType<typeof defineConfig>` annotations no longer crash `push`, requires an explicit `--schema-name` (or `schemaName` export / `$smooaiName` field) to prevent accidental schema creation from `cwd` basename, surfaces server-side `{ success: false }` envelopes as real errors instead of silent empty lists, and ships a refreshed Ink UI with Smoo AI brand colors, a larger `Smoo AI` banner, boxed summary/success/error panels, secret redaction on `set`/`list`, and actionable `Try: …` hints on failures. Legacy `--api-key` continues to work.

## 4.3.1

### Patch Changes

- 42206e5: Docstring-only rename: "cohort" → "segment" across TS/Python/Rust/Go feature-flag evaluator surfaces. The underlying API (`evaluateFeatureFlag(key, context)`, `createFeatureFlagEvaluator`) is unchanged; only prose and JSDoc/comments pick up the more industry-standard "segment" terminology. Design doc renamed `DESIGN-cohort-context.md` → `DESIGN-segment-context.md`.

## 4.3.0

### Minor Changes

- ba11618: SMOODEV-624: Add cohort-aware feature-flag evaluator client API. New `ConfigClient.evaluateFeatureFlag(key, context?, environment?)` async method hits the server-side evaluator endpoint so cohort rules (percentage rollout, attribute matching, bucketing) actually fire. New `createFeatureFlagEvaluator<FlagKeys>(client)` factory in `@smooai/config/client` mirrors the existing `createFeatureFlagChecker` shape for typed keys. Typed errors: `FeatureFlagEvaluationError`, `FeatureFlagNotFoundError`, `FeatureFlagContextError` — catch once, map to 400/404/5xx cleanly. Existing sync `getFeatureFlag` unchanged — callers who don't need cohorts keep the cache-read path. TypeScript only in this release; Python/Rust/Go parity follows.

## 4.2.3

### Patch Changes

- f8c0d18: **Docs: reframe TypeScript README as a capability showcase + link synckit**
    - Replaced the "What's New in v3" section with a "What's in the box" showcase that lists what each subpath does — no version-narrative framing, since the SDK is still in its early rollout.
    - Added an outbound link to [`un-ts/synckit`](https://github.com/un-ts/synckit) in the `.getSync()` architecture section so readers can find the actual library we use for sync-over-async via `worker_threads` + `Atomics.wait` + `SharedArrayBuffer`.

    Docs-only. No behavioural change.

## 4.2.2

### Patch Changes

- f7c67fb: **Docs: generalise the `.getSync()` sidecar guidance to any bundled compute**

    The README previously framed the sync-worker sidecar pattern as a "Lambda via SST" optimisation. The sidecar is the right approach for _any_ bundled compute runtime — Lambda, Cloud Run, ECS, containers, Serverless Framework, SAM, plain esbuild/tsup outputs.

    Expanded the "How `.getSync()` works" section with:
    - A clearer explanation that the sidecar vs. `/tmp` fallback is about bundling, not about which cloud you run on.
    - Concrete recipes for esbuild, tsup, Serverless Framework, SST, Docker containers, and plain Node (already works with no config).
    - An explicit "you can ignore this" callout — path (2) is a working safety net, the sidecar just saves one `/tmp` write per cold start.
    - Edge runtime note stays as-is — `.getSync()` needs `worker_threads`, which edge runtimes don't expose, so the answer there is always `.get()` async.

    No code changes.

## 4.2.1

### Patch Changes

- 6008045: **Fix Vite/webpack consumer builds pulling `rotating-file-stream` via stale `@smooai/fetch`**

    The previous release (4.2.0) dropped `@smooai/fetch` from `tsup`'s browser `noExternal`, relying on `@smooai/fetch@3.1.0`'s new top-level `browser` export condition to do the right thing on consumer side. That's brittle: if a consumer's dep tree resolves `@smooai/fetch` to `2.x` elsewhere (smooai monorepo currently does), `platform: 'browser'` falls back to the Node entry, which pulls `@smooai/logger` + `rotating-file-stream`, breaking the build with:

    ```
    "access" is not exported by "__vite-browser-external", imported by "rotating-file-stream/dist/esm/index.js"
    ```

    This patch:
    1. Re-adds `@smooai/fetch` to the browser build's `noExternal` list, so fetch is bundled into `dist/browser/` and consumers never need to resolve it themselves. Adds a few KB to the browser dist for robustness — not dependent on consumer-side resolution.

    2. Bumps the declared `@smooai/fetch` dep from `^2.1.0` to `^3.1.0` so the inlined version benefits from the browser condition.

    No API changes. 4.1.x consumers upgrading to 4.2.1 get a clean browser build with zero Node-only transitive pulls.

## 4.2.0

### Minor Changes

- 7a15a61: **Unified client env bag + sidecar sync-worker + drop fetch/logger aliases**

    Three related cleanups that remove long-standing workarounds.

    ### 1. Unified `__SMOO_CLIENT_ENV__` (fixes Next.js "(unset)" + Vite dynamic-lookup)

    The browser SDK helpers `getClientPublicConfig(key)` / `getClientFeatureFlag(key)` use dynamic-key env lookups (`obj[computedKey]`). Bundlers only static-replace literal `process.env.X` / `import.meta.env.X`, so those lookups always returned `undefined` at runtime — Next.js showed `(unset)` for baked public config; Vite relied on a `globalThis.__VITE_ENV__` shim injected by `smooConfigPlugin`.

    Both bundler plugins now define a single namespaced global:
    - `smooConfigPlugin` (Vite) — adds `__SMOO_CLIENT_ENV__` to Vite's `define`
    - `withSmooConfig` (Next.js) — registers a webpack `DefinePlugin` that substitutes `__SMOO_CLIENT_ENV__` with the same literal object

    The SDK reads through that one global. No `globalThis` fallback, no `process.env` shim, one code path.

    Existing `next.config.env` + per-key `process.env.NEXT_PUBLIC_*` and `import.meta.env.VITE_*` substitutions are untouched — the normal ergonomic of direct static reads still works.

    ### 2. Sync worker sidecar file (optional `copyFiles` optimisation)

    `buildConfig(schema).*.getSync(...)` previously extracted the embedded worker source to `/tmp` on first use in every process (SMOODEV-617). The SDK now tries a sidecar file at `./sync-worker.mjs` (next to the compiled `server/index.mjs`) first, and only falls back to `/tmp` extraction when the sidecar isn't present.

    Consumers that want zero `/tmp` writes on Lambda can copy the sidecar into the deploy package — recommended via SST `$transform`:

    ```typescript
    $transform(sst.aws.Function, (fn) => {
        fn.copyFiles = [...(fn.copyFiles ?? []), { from: 'node_modules/@smooai/config/dist/server/sync-worker.mjs' }];
    });
    ```

    No consumer action required — the `/tmp` fallback keeps existing deployments working. Full documentation in the README under "How `.getSync()` works".

    ### 3. Drop `@smooai/fetch` + `@smooai/logger/Logger` aliases in the browser build

    `@smooai/fetch@3.1.0` and `@smooai/logger@4.0.4+` both added top-level `browser` export conditions, so `platform: 'browser'` bundles pick the right entry automatically. Removed the `esbuild-plugin-alias` workarounds + the `@smooai/fetch/browser/index` path rewrite. Schema-serializer stubs (`arktype`, `effect`, `@valibot/to-json-schema`, `json-schema-to-zod`, `esm-utils`, `rotating-file-stream`) are unchanged.

## 4.1.4

### Patch Changes

- 68dad85: **SMOODEV-646: `smooConfigPlugin` — inject `process.env.VITE_*` as well as `import.meta.env.VITE_*`**

    `getClientPublicConfig` / `getClientFeatureFlag` read `process.env.VITE_*` by design (so the same SDK code path works on Next.js + Vite). The Vite plugin previously only substituted `import.meta.env.VITE_*`, so at browser runtime the SDK getters returned `undefined` — no bundle-baked values.

    Fix: the plugin now emits **both** `import.meta.env.VITE_X` and `process.env.VITE_X` define entries. Bundled values finally make it through to `getClientPublicConfig('apiUrl')` / `getClientFeatureFlag('observability')` in Vite apps.

- 68dad85: **SMOODEV-647: `smooConfigPlugin` populates `globalThis.__VITE_ENV__` for dynamic SDK getters**

    `getClientPublicConfig(key)` / `getClientFeatureFlag(key)` use DYNAMIC property access (`process.env[\`VITE*CONFIG*\${envKey}\`]`) which Vite's `define`can't substitute per-key. The SDK's getters already had a fallback path checking`globalThis.**VITE_ENV**` at runtime — the plugin just never populated it.

    The plugin now emits `define: { 'globalThis.__VITE_ENV__': JSON.stringify(envVars) }` in addition to the per-key static substitutions. Bundle-baked values now flow through the SDK's dynamic getters in Vite apps.

## 4.1.3

### Patch Changes

- 3a029bd: **SMOODEV-645: fix browser bundle pulling Node-only deps via `@smooai/fetch`**

    `@smooai/config/client` (and `/react`) broke Vite / Next.js consumer builds with `Module 'node:v8' has been externalized`. Root cause: `platform/client.ts` does `import fetch from '@smooai/fetch'`, but `@smooai/fetch`'s package.json exposes its browser entry only as the `./browser/*` subpath — it has no top-level `browser` condition. In the tsup browser build, the bare specifier resolved to the Node entry, dragging in `@smooai/logger` + `rotating-file-stream` + `import-meta-resolve`.

    Fix: in the browser tsup build, add `@smooai/fetch` to `noExternal` and alias the bare specifier to `@smooai/fetch/browser/index` via esbuild's native `alias`. Browser chunks now inline the browser-safe fetch implementation.

    Verified:

    ```
    grep -l "rotating-file-stream\|@smooai/logger" dist/browser/chunk-*.mjs
    # (no matches)

    grep "@smooai/fetch/dist/browser" dist/browser/chunk-*.mjs
    # chunk-...: // node_modules/.../@smooai/fetch/dist/browser/index.mjs
    ```

    Frontend consumers no longer need to manually alias `@smooai/fetch`.

- 3a029bd: **SMOODEV-646: `smooConfigPlugin` — inject `process.env.VITE_*` as well as `import.meta.env.VITE_*`**

    `getClientPublicConfig` / `getClientFeatureFlag` read `process.env.VITE_*` by design (so the same SDK code path works on Next.js + Vite). The Vite plugin previously only substituted `import.meta.env.VITE_*`, so at browser runtime the SDK getters returned `undefined` — no bundle-baked values.

    Fix: the plugin now emits **both** `import.meta.env.VITE_X` and `process.env.VITE_X` define entries. Bundled values finally make it through to `getClientPublicConfig('apiUrl')` / `getClientFeatureFlag('observability')` in Vite apps.

## 4.1.2

### Patch Changes

- 3a64833: **SMOODEV-645: fix browser bundle pulling Node-only deps via `@smooai/fetch`**

    `@smooai/config/client` (and `/react`) broke Vite / Next.js consumer builds with `Module 'node:v8' has been externalized`. Root cause: `platform/client.ts` does `import fetch from '@smooai/fetch'`, but `@smooai/fetch`'s package.json exposes its browser entry only as the `./browser/*` subpath — it has no top-level `browser` condition. In the tsup browser build, the bare specifier resolved to the Node entry, dragging in `@smooai/logger` + `rotating-file-stream` + `import-meta-resolve`.

    Fix: in the browser tsup build, add `@smooai/fetch` to `noExternal` and alias the bare specifier to `@smooai/fetch/browser/index` via esbuild's native `alias`. Browser chunks now inline the browser-safe fetch implementation.

    Verified:

    ```
    grep -l "rotating-file-stream\|@smooai/logger" dist/browser/chunk-*.mjs
    # (no matches)

    grep "@smooai/fetch/dist/browser" dist/browser/chunk-*.mjs
    # chunk-...: // node_modules/.../@smooai/fetch/dist/browser/index.mjs
    ```

    Frontend consumers no longer need to manually alias `@smooai/fetch`.

## 4.1.1

### Patch Changes

- 82c85aa: **SMOODEV-642: `getSource()` now reflects sync reads**

    `cfg.getSource(key)` used to return `undefined` for any key that had only been read via `.getSync()`. Each synckit worker has its own module scope, so the worker's `lastSource` map never propagated back to the parent thread.

    Fix: the synckit worker now returns a `{ value, source }` envelope. The parent-thread wrapper in `/server/index.ts` calls a new internal `recordSource(key, source)` helper to copy the source into its own `lastSource` map. `getSource` works identically for sync + async reads now.

## 4.1.0

### Minor Changes

- 301367a: **SMOODEV-617: fix `.getSync()` for bundled consumers (Lambda, Vercel, Next.js)**

    `buildConfig(schema).<tier>.getSync(key)` used to hang indefinitely when the SDK was bundled by esbuild — in AWS Lambda bundles, Vercel edge, or any tsup/rollup consumer. Root cause: `createSyncFn(path)` needs a physical `.js` worker file on disk, but the consumer's bundler tree-shook it out.

    Fix: the SDK now bundles the synckit worker into a **string constant** at SDK build time (via `scripts/build-sync-worker.mjs`), and at first-use writes that string to `mkdtempSync()/sync-worker.mjs` before handing the `file://` URL to `createSyncFn`. Zero consumer configuration required — works out of the box inside Lambdas, Vercel fns, Fargate tasks, CLI scripts.

    ### What changed
    - New build step: `pnpm build:sync-worker` runs before `pnpm tsup`, emitting `src/server/sync-worker-source.generated.ts` with the full ESM worker source (every dep inlined except Node builtins, CJS `require` polyfilled via `createRequire(import.meta.url)`).
    - `src/server/index.ts` imports `WORKER_SOURCE` and materializes it to `/tmp` once per process.
    - Smoke tests confirm `.getSync()` returns in ~50ms incl. worker spawn, matches `.get()` (async) output exactly.

    ### No API change

    Consumers do not need to touch their code. Existing `buildConfig(schema).secretConfig.getSync('foo')` calls just work once `@smooai/config` is bumped.

## 4.0.0

### Major Changes

- 81fb028: **Breaking: unified `/server` + `/client` SDK (SMOODEV-611)**

    The `/platform/runtime` and `/platform/server` entrypoints have been collapsed
    into a single `@smooai/config/server` export with a unified priority chain.
    `@smooai/config/client` has been expanded to mirror the same tier shape on
    the browser side (without `secretConfig`).

    ### New backend surface — `@smooai/config/server`

    ```ts
    import { buildConfig } from '@smooai/config/server';
    import schema from '../../.smooai-config/config';

    const config = buildConfig(schema);

    // Async (idiomatic):
    await config.secretConfig.get('sendgridApiKey');

    // Sync (drop-in for constructors / top-level init, via synckit):
    config.secretConfig.getSync('sendgridApiKey');
    config.publicConfig.getSync('apiUrl');
    config.featureFlag.getSync('observability');
    ```

    Priority chain (public + secret):
    1. **Baked blob** — AES-GCM `.enc` placed by the deploy-time baker.
    2. **Env vars** — `process.env[UPPER_SNAKE_CASE_KEY]`. Per-key overrides.
    3. **HTTP config API** — live fetch via `ConfigClient`.
    4. **Local file** — defaults shipped under `.smooai-config/`.

    Feature flags invert the top of the chain: HTTP first (live, 30s cache),
    then env, then file. Blob is intentionally skipped so flags flip without
    a redeploy.

    ### New frontend surface — `@smooai/config/client`

    `buildClientConfig(schema)` exposes `publicConfig` + `featureFlag` (no
    `secretConfig` — enforced at the type level). Reads bundle-baked env vars
    first (`NEXT_PUBLIC_CONFIG_*` / `VITE_CONFIG_*`), falls through to HTTP.

    ### Migration

    ```diff
    - import { buildConfigRuntime } from '@smooai/config/platform/runtime';
    - const config = buildConfigRuntime(schema);
    - await config.getSecretConfig('foo');

    + import { buildConfig } from '@smooai/config/server';
    + const config = buildConfig(schema);
    + await config.secretConfig.get('foo');
    + config.secretConfig.getSync('foo');
    ```

    ```diff
    - import buildConfigObject from '@smooai/config/platform/server';
    - const config = buildConfigObject(schema);
    - await config.publicConfig.getAsync('foo');
    - config.publicConfig.getSync('foo');

    + import { buildConfig } from '@smooai/config/server';
    + const config = buildConfig(schema);
    + await config.publicConfig.get('foo');
    + config.publicConfig.getSync('foo');
    ```

    ### Removed
    - `@smooai/config/platform/runtime` — `buildConfigRuntime`, `readBakedConfig`, `hydrateConfigClient`
    - `@smooai/config/platform/server` — `buildConfigObject`
    - The internal `server.async` / `server.publicConfig.sync` / etc. worker files

    Low-level building blocks stay:
    - `@smooai/config/platform/client` — `ConfigClient` (HTTP-only class, used internally by `/server` and `/client`)
    - `@smooai/config/platform/build` — `buildBundle` (deploy-time baker)

    ### Language parity

    Python / Rust / Go SDKs remain on the pre-unification API for now. Parity
    ports tracked as follow-up tickets — consumers of those SDKs are unaffected
    by this release.

## 3.4.0

### Minor Changes

- d07e590: **SMOODEV-615** — Python-client parity for the baked-blob pattern + TypeScript runtime tests.
    - `python/src/smooai_config/runtime.py` — `read_baked_config()`, `hydrate_config_client(client)`, `build_config_runtime()`. AES-256-GCM decrypt via `cryptography` library, reads `SMOO_CONFIG_KEY_FILE` + `SMOO_CONFIG_KEY`, seeds `ConfigClient`'s cache so Python consumers get the same uniform `get_value(key)` API as TypeScript.
    - `python/src/smooai_config/build.py` — `build_bundle()` baker + `classify_from_schema()` factory. Random 12-byte nonce, wire-compatible blob layout with the TypeScript baker (a Python-baked blob can be decrypted by the TypeScript runtime and vice versa).
    - `python/src/smooai_config/client.py` — adds `seed_cache_from_map()` method alongside the existing `get_value` / `get_all_values`. Thread-safe via the existing `RLock`.
    - `python/tests/test_runtime.py` — round-trip encrypt/decrypt, hydrate seeds client cache, bad key + corrupt blob rejection.
    - `src/platform/runtime.test.ts` — matching TypeScript unit test suite for `runtime.ts` (PR #15 didn't ship tests). 8 cases covering `readBakedConfig` happy path + error cases, `hydrateConfigClient` seeding, and `buildConfigRuntime` tier accessors.

    Rust + Go parity tracked separately (see `docs/Infrastructure/Smoo-Config-Feature-Flags.md` § Language-client parity) — blob format is fixed so any language's baker and any language's runtime interop cleanly.

## 3.3.0

### Minor Changes

- 68e719a: Expose two lower-level runtime helpers alongside `buildConfigRuntime`:
    - `readBakedConfig()` — returns the decrypted `{ public, secret }` map from the baked blob (or `undefined` if no blob is present). Cached in module scope.
    - `hydrateConfigClient(client, environment?)` — seeds a `ConfigClient`'s cache from the baked blob so `client.getValue(key)` returns public + secret values synchronously after the first call. Feature flags keep their live-fetch semantics.

    Both are useful when a consumer's TypeScript project can't import the full `defineConfig` schema type (e.g., 100+ key schemas hitting tsgo's inferred-type serialization limit). The existing `buildConfigRuntime(schema)` path is unchanged.

## 3.2.0

### Minor Changes

- 87ff52d: Add `@smooai/config/platform/runtime` and `@smooai/config/platform/build` — framework-agnostic bake-and-decrypt pattern for shipping config to deployment targets (Lambda, ECS, Fargate, EC2, containers, anywhere Node + filesystem).

    **Pattern** (mirrors SST v4's `Resource.*` cold-start-decrypt, without the SST coupling):
    1. Deploy-time baker (`buildBundle`) calls `ConfigClient.getAllValues(env)`, partitions via `classifyFromSchema` (public + secret into the blob, feature flags skipped), encrypts with AES-256-GCM, returns `{ keyB64, bundle }`. Deploy glue writes the bundle to disk and sets `SMOO_CONFIG_KEY_FILE` + `SMOO_CONFIG_KEY` on the function.
    2. Runtime helper (`buildConfigRuntime(schema)`) decrypts the blob once at cold start and exposes the same typed `getPublicConfig` / `getSecretConfig` / `getFeatureFlag` API as the existing `buildConfigObject` — consumer code stays identical.
    3. Feature flags always hit the config API at runtime (they're designed to flip without a redeploy), routed through a cached `ConfigClient`.

    Blob layout: `nonce (12 random bytes) || ciphertext || authTag (16 bytes)`. Random nonce + fresh key per `buildBundle` — no key-reuse hazard across re-bakes.

    Paired with a deploy-pipeline adapter in your infra repo (SST, Pulumi, Vercel, whatever), this eliminates the 4 KB Lambda env-var ceiling for secrets while keeping the library API unchanged.

- fec5b31: Use Zod v4's built-in `z.toJSONSchema()` instead of the `zod-to-json-schema` adapter. Drops the adapter dep (typed against Zod v3 — needed `as any` casts to pass Zod v4 schemas through) and removes the related stubs from the browser-build alias map. Runtime output shape is equivalent. Also drops the `zod-to-json-schema` runtime dependency.

### Patch Changes

- 816e23d: **SMOODEV-602** — CLI + runtime client fixes surfaced while dogfooding the
  three-tier schema in the smooai monorepo:
    - `smooai-config diff/push/pull` no longer fails with
      `ERR_UNKNOWN_FILE_EXTENSION` on `.smooai-config/config.ts`. The schema
      loader used a bare `await import(tsPath)` which Node can't resolve for
      `.ts` files — switched to `tsImport` from `tsx/esm/api` (tsx is already
      a runtime dep of this package), so the CLI works out of the box in any
      project that declares its schema in TypeScript.
    - Both HTTP paths (`src/platform/client.ts` runtime client and
      `src/cli/utils/api-client.ts` CLI client) now route through
      `@smooai/fetch` — which dogfoods our own resilient-fetch package for
      retries, 429 Retry-After honoring, and clearer error surfaces.
      `@smooai/fetch` was already a dependency; it just wasn't being used.

    No API-surface change. Drop-in patch release.

- ce09743: Improve README with v3 features, type safety examples, and React/Next.js focus

## 3.0.0

### Major Changes

- d7c297a: BREAKING: Split browser/server exports for `@smooai/config`. The `./config` entrypoint no longer re-exports `findAndProcessFileConfig` or `findAndProcessEnvConfig` — server-only consumers must import from `@smooai/config/config/server` instead. Added `dist/browser/` build with esbuild alias stubs so browser bundles never pull in Node.js-only dependencies (Logger, esm-utils, schema serializers, etc.). Added `"browser"` conditional exports for all browser-safe paths.

## 2.1.4

### Patch Changes

- 7b55050: Add Python, Rust, and Go language-specific READMEs with cross-language install table and idiomatic usage examples. Also document `.smooai-config` tsconfig setup for TypeScript users.
- Split nextjs entry point to avoid React createContext crash in server bundles. Added `@smooai/config/nextjs/client` and `@smooai/config/nextjs/getConfig` explicit exports.

## 2.1.3

### Patch Changes

- Remove create-entry-points from build:lib and add explicit subpath exports for directory modules (nextjs, react, vite, config, utils). The wildcard export pattern ./\* only resolves flat files, not directory index files, so explicit entries are needed for proper module resolution.

## 2.1.2

### Patch Changes

- Fix subpath exports for directory-based entry points (nextjs, react, vite, config)

## 2.1.1

### Patch Changes

- Fix subpath exports for directory-based entry points (nextjs, react, vite, config)

    The wildcard export `./*` only resolves flat files (e.g., `dist/platform/client.mjs`) but not directory index files (e.g., `dist/nextjs/index.mjs`). Added explicit exports for `./nextjs`, `./react`, `./vite`, and `./config` subpaths.

## 2.1.0

### Minor Changes

- Add Next.js and Vite integrations to published package
    - `@smooai/config/nextjs` — `getConfig()` for Server Components, `SmooConfigProvider` for SSR pre-seeding, `useFeatureFlag()` and `usePublicConfig()` hooks
    - `@smooai/config/vite` — `preloadConfig()` for early fetch, `getPreloadedConfig()` for sync access
    - `ConfigClient.getAllValues()` now accepts optional `fetchOptions` parameter for Next.js ISR revalidation

## 2.0.4

### Patch Changes

- 3f65d3f: Fix crates.io publish: allow dirty working tree after version sync

## 2.0.3

### Patch Changes

- 77cf41b: Fix PyPI publish: clean dist/ before building to avoid re-uploading old versions

## 2.0.2

### Patch Changes

- ad69f8c: Fix release workflow race condition and publish to crates.io/Go module

## 2.0.1

### Patch Changes

- 973ffe3: Fix release workflow: regenerate Cargo.lock before crates.io publish, remove lint-staged

## 2.0.0

### Major Changes

- 842dd0f: ## @smooai/config v2.0.0

    ### Cross-Language Schema Validation
    - Add `validateSmooaiSchema()` — validates JSON Schema uses only the cross-language-compatible subset
    - TypeScript: Pre-validation detects unsupported Zod types (z.function, z.transform, z.lazy, z.map, z.set, z.bigint, z.date) with actionable errors
    - Python: Pre-validation detects unsupported Pydantic features (computed_field, Callable fields)
    - Rust/Go: Post-conversion validation on generated JSON Schema
    - Shared test fixtures ensure identical behavior across all 4 languages

    ### Native Type to JSON Schema in Rust and Go
    - Rust: `define_config_typed::<P, S, F>()` using schemars for compile-time type-safe schema generation
    - Go: `DefineConfigTyped()` using invopop/jsonschema for struct-based schema generation
    - Both validate generated schemas via the cross-language validation layer

    ### Project File Convention for All Languages
    - Language-specific generator files: `.smooai-config/schema_gen.py`, `.smooai-config/main.go`, `.smooai-config/Cargo.toml`
    - CLI `init` generates language-appropriate templates
    - CLI `push` auto-detects and runs generators
    - Fallback to `.smooai-config/schema.json` for any language

    ### Deferred/Computed Config Values
    - Python: `resolve_deferred_values()` — callable config overrides resolved after merge
    - Rust: `.with_deferred(key, closure)` builder on ConfigManager
    - Go: `WithDeferred(key, fn)` option on ConfigManager
    - All languages resolve against pre-resolution config snapshot

    ### Comprehensive Mock-Based Integration Tests
    - TS CliApiClient: 44 MSW tests covering auth, schema CRUD, environments, values, error handling, helper methods, and full workflows
    - Rust ConfigClient: 9 wiremock tests covering get/getAll, auth, caching, TTL, invalidation, errors, and per-environment isolation
    - Complements existing mock tests: TS ConfigClient (MSW + real HTTP server), Python (httpx.MockTransport), Go (httptest.Server), Rust ConfigManager (wiremock)

    ### Published as Public Package
    - Package published to npm as `@smooai/config` (public access)
    - Removed SST dependency (E2E tests moved to main monorepo)

## 1.1.0

### Minor Changes

- c589224: Add TTL caching, selective environment invalidation, and thread safety to all SDK runtime clients (TypeScript, Python, Go, Rust). Add extensive integration tests for all 4 languages covering API interactions, caching behavior, TTL expiry, and error handling.

## 1.0.8

### Patch Changes

- 8e7f8b1: Rewrite README from library-template placeholder to comprehensive documentation covering multi-language support (TypeScript, Python, Rust, Go), StandardSchema validation, three-tier configuration, usage examples, and development commands. Update package.json description.

## 1.0.7

### Patch Changes

- 2acd2b0: Updated all vite dependencies.

## 1.0.6

### Patch Changes

- 5e40d5a: Update smoo dependencies.

## 1.0.5

### Patch Changes

- d4fa579: Upgrade node types to v22.

## 1.0.4

### Patch Changes

- 19a5fd7: Upgraded to Node 22.

## 1.0.3

### Patch Changes

- 166a8f0: Update dependencies.
- 166a8f0: Update to working @smooai/logger.

## 1.0.2

### Patch Changes

- 44fd23b: Fix publish for Github releases.

## 1.0.1

### Patch Changes

- 52c9eb1: Initial check-in.
