---
'@smooai/config': minor
---

**SMOODEV-615** — Python-client parity for the baked-blob pattern + TypeScript runtime tests.

- `python/src/smooai_config/runtime.py` — `read_baked_config()`, `hydrate_config_client(client)`, `build_config_runtime()`. AES-256-GCM decrypt via `cryptography` library, reads `SMOO_CONFIG_KEY_FILE` + `SMOO_CONFIG_KEY`, seeds `ConfigClient`'s cache so Python consumers get the same uniform `get_value(key)` API as TypeScript.
- `python/src/smooai_config/build.py` — `build_bundle()` baker + `classify_from_schema()` factory. Random 12-byte nonce, wire-compatible blob layout with the TypeScript baker (a Python-baked blob can be decrypted by the TypeScript runtime and vice versa).
- `python/src/smooai_config/client.py` — adds `seed_cache_from_map()` method alongside the existing `get_value` / `get_all_values`. Thread-safe via the existing `RLock`.
- `python/tests/test_runtime.py` — round-trip encrypt/decrypt, hydrate seeds client cache, bad key + corrupt blob rejection.
- `src/platform/runtime.test.ts` — matching TypeScript unit test suite for `runtime.ts` (PR #15 didn't ship tests). 8 cases covering `readBakedConfig` happy path + error cases, `hydrateConfigClient` seeding, and `buildConfigRuntime` tier accessors.

Rust + Go parity tracked separately (see `docs/Infrastructure/Smoo-Config-Feature-Flags.md` § Language-client parity) — blob format is fixed so any language's baker and any language's runtime interop cleanly.
