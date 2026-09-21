---
'@smooai/config': patch
---

SMOODEV-1136: The TypeScript server SDK now validates the baked blob's environment against `SMOOAI_CONFIG_ENV` at read time. Previously a dev-baked blob (e.g. the one `pnpm install` writes on a developer laptop) would silently serve dev values to a prod-targeting script even when `SMOOAI_CONFIG_ENV=production` was set — because the blob tier sits at the top of the priority chain and never consulted the active environment. Now `buildBundle` persists a `bakedEnvironment` field into the encrypted payload, and the reader skips the blob (with a one-time warning per `(baked, active)` pair) when the blob's environment doesn't match `SMOOAI_CONFIG_ENV`, so the chain falls through to env → HTTP → file. Legacy blobs without the field are treated as `'development'` for back-compat.

Also adds a per-call `forceTier` option on `publicConfig.get` / `secretConfig.get` / `featureFlag.get` (sync + async): pass `{ forceTier: 'http' }` (or `'blob' | 'env' | 'file'`) to read from exactly one tier with no fallback and bypass the in-process value cache. Cleaner than the previously-documented workaround of stripping `SMOO_CONFIG_KEY` / `SMOO_CONFIG_KEY_FILE` env vars before running prod-targeting scripts.

Fix is TypeScript-only in this release; the .NET / Python / Go / Rust SDKs will follow.
