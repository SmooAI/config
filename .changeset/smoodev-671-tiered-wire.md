---
'@smooai/config': patch
---

SMOODEV-671: CLI push emits proper tiered JSON Schema for server-side storage

`defineConfig()` now exposes `serializedAllConfigSchemaJsonSchema` — a full JSON Schema document with `publicConfigSchema` / `secretConfigSchema` / `featureFlagSchema` tier nodes and per-key `{type: 'string' | 'boolean' | 'number'}` (or full JSON Schema for zod/valibot/effect fields). This is the wire format the /apps/config dashboard expects.

`smooai-config push` prefers this new property when available and falls back to the existing flat `serializedAllConfigSchema` (legacy configs) so pushes from older consumers keep working. The flat export is unchanged, so local runtime, buildBundle, and source generators are unaffected.
