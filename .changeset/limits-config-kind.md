---
'@smooai/config': minor
---

SMOODEV-2306: Add **limits** — a fourth config kind. A limit is a numeric,
segment-resolved, clamp-aware value that resolves live through the same server
segment evaluator as feature flags (never baked) and tunes a soft target
within a client-applied `[min, max]` clamp.

- Schema: `defineConfig({ limitsSchema })` + `defineLimit({ default, min, max, step })`, exposing `LimitKeys` + `_limitsMeta`, serialized as bounded JSON-Schema number nodes.
- TS client: `ConfigClient.evaluateLimit`, `createLimitEvaluator`, `getClientLimit`, `clampLimit`, and a `limit` tier (`getLimit` sync + `evaluateLimit` async, clamped) on `buildClientConfig` / `buildConfig`.
- Polyglot parity (mirroring the feature-flag evaluator): Rust `evaluate_limit` + `clamp_limit`, Python `evaluate_limit` + `clamp_limit`, Go `EvaluateLimit` + `ClampLimit`, .NET `EvaluateLimitAsync` + `LimitSpec.Clamp`, each with typed `Limit*` error types.

Endpoint contract: `POST /organizations/{org_id}/config/limits/{key}/evaluate`.
