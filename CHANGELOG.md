# @smooai/library-template

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
