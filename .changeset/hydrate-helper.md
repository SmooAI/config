---
'@smooai/config': minor
---

Expose two lower-level runtime helpers alongside `buildConfigRuntime`:

- `readBakedConfig()` — returns the decrypted `{ public, secret }` map from the baked blob (or `undefined` if no blob is present). Cached in module scope.
- `hydrateConfigClient(client, environment?)` — seeds a `ConfigClient`'s cache from the baked blob so `client.getValue(key)` returns public + secret values synchronously after the first call. Feature flags keep their live-fetch semantics.

Both are useful when a consumer's TypeScript project can't import the full `defineConfig` schema type (e.g., 100+ key schemas hitting tsgo's inferred-type serialization limit). The existing `buildConfigRuntime(schema)` path is unchanged.
