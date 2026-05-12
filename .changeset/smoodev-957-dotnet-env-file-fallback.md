---
'@smooai/config': patch
---

SMOODEV-957: Extend `ConfigKey<T>.ResolveAsync` in the .NET SDK to the full SMOODEV-857 priority chain — **baked runtime → `SMOOAI_CONFIG_<KEY>` env var → live HTTP → local `.smooai-config/<env>.json`**. Previously the .NET port only did `baked → HTTP`, so deployments that needed a single key overridden without a re-bake had no env-var path, and dev laptops without network connectivity had no file-tier fallback.

- Env-var names follow the existing convention (`moonshotApiKey` → `SMOOAI_CONFIG_MOONSHOT_API_KEY`). JSON-shaped values are parsed; primitives become JSON strings so the typed deserializer round-trips correctly.
- File-tier reads from `$SMOOAI_CONFIG_FILE_DIR/<env>.json` (or `./.smooai-config/<env>.json`). Malformed or missing files are silent — same posture as TS / Python / Rust / Go.
- HTTP failures (`HttpRequestException`, `SmooConfigApiException`, request timeouts) fall through to the file tier so an offline laptop can still resolve from local defaults. Caller cancellation still propagates.
- `SmooConfigClient.DefaultEnvironment` is now exposed internally so the file-tier lookup aligns with whatever env name the HTTP tier would have used.
