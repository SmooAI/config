---
'@smooai/config': patch
---

**SMOODEV-611: README sweep — unified priority chain + v4 migration callouts**

Documents the `@smooai/config@4.0.0` unified SDK + the fallback chain that's now identical across TypeScript, Python, Rust, and Go implementations.

- Main `README.md` — new `## Priority Chain` section with fallback diagrams for public/secret, feature flag, and frontend bundle chains. Clarifies "first non-empty source wins" vs "override stack". Adds `## What's New in v4` callouts, updates `## Server-Side Config Access` to the new `buildConfig(schema)` API, rewrites `## Multi-Language Support` with a parity status table.
- Python, Rust, Go READMEs — each gets a short `### Priority chain` section pointing at the main README for the full diagrams + a parity status note linking the SMOODEV ticket for each language's port.
- `### The .smooai-config/ local file tier` — new subsection explaining deep-merge order (`default.*` → `<env>.*` → `<env>.<cloud>.*` → `<env>.<cloud>.<region>.*`), directory lookup via `SMOOAI_ENV_CONFIG_DIR`, and environment selection via `SMOOAI_CONFIG_ENV`.

No code changes.
