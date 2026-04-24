---
'@smooai/config': minor
---

SmooAI.Config .NET phase 2: ship full parity with the TypeScript, Python, Rust, and Go clients.

- **Local runtime** (`SmooConfigRuntime`) — AES-256-GCM decrypt of a baked bundle from `SMOO_CONFIG_KEY_FILE` + `SMOO_CONFIG_KEY`. Wire-compatible with every other language client (12-byte nonce || ciphertext || 16-byte tag). Thread-safe lazy singleton with env-var fallback for local dev.
- **Build pipeline** (`SmooConfigBuilder.BuildAsync`) — fetches all values via the HTTP client, partitions public/secret via a `Classify` delegate (feature flags skipped), emits an encrypted bundle + base64 AES key. `SchemaClassifier.FromSchemaFile` reads a `schema.json` (JSON-Schema shape or serialized `defineConfig` shape).
- **Roslyn source generator** — reads a `schema.json` from the consumer's `AdditionalFiles` and emits strongly-typed `Public.*`, `Secrets.*`, `FeatureFlags.*` static `ConfigKey<T>` properties under `SmooAI.Config.Generated`. Shipped inside the main `SmooAI.Config` NuGet — one package install, compile-time-safe key access.
- **Typed key API** (`ConfigKey<T>`) — `.GetAsync(client)`, `.Get(runtime)`, `.ResolveAsync(runtime, client)`. Runtime-baked values resolve synchronously; missing keys fall through to the HTTP client.
- **Great NuGet README** — rewritten with quickstart, feature overview, and wire-compat notes. Renders on nuget.org.
- **Version sync** — `scripts/sync-versions.mjs` now bumps the `.csproj` to the npm version on every Changesets release; the Release workflow publishes to NuGet alongside PyPI/crates.io/Go. NuGet version aligns with the npm version (first synced release: 4.4.0).
