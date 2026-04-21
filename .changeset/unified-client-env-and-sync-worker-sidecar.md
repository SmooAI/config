---
'@smooai/config': minor
---

**Unified client env bag + sidecar sync-worker + drop fetch/logger aliases**

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
