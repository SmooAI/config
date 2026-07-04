# SMOODEV-2306 — Limits: the fourth config kind

> Design notes for adding **limits** to `@smooai/config`. A limit is a
> NUMERIC config value that resolves contextually (per user / segment / org)
> through the SAME server-side segment evaluator as feature flags, and is
> **never baked** — it always resolves live. Background: SMOODEV-614/624
> (`DESIGN-segment-context.md`) landed the segment evaluator (`$cohort`
> envelope, `rules`, `defaultValue`, `bucketBy`, `rollout`) and the client
> `evaluateFeatureFlag(key, context)` method across TS / Python / Rust / Go /
> .NET. Limits are the numeric sibling — a thin, additive layer that reuses
> that machinery instead of inventing a new one.

## Why a new kind

We have three config kinds today: `publicConfigSchema` (client + server),
`secretConfigSchema` (server-only), `featureFlagSchema` (boolean/string, live).
None of them fit a **soft, tunable numeric target** — a value that:

- is a number, resolved differently per `{ orgId, agentId, plan, … }`,
- is **not a hard limit**: consuming code always applies its own hard clamp,
  and the config value only tunes _within_ `[min, max]`,
- must flip without a redeploy (live, like a feature flag), and
- carries its own clamp metadata so a bad/stale server value can never push a
  consumer outside a safe range.

Motivating consumer: **smooth-operator** reads limit `agentMaxIterations` by
`{ orgId, agentId }` to replace the `SMOOTH_AGENT_MAX_ITERATIONS` env stopgap.
The operator still hard-clamps to its own `[1, 50]`; the limit tunes the target
inside that (12 by default, 20 for the enterprise segment, etc.).

## Core decision: reuse the feature-flag evaluator, typed as a number

A limit resolves through the identical segment machinery as a feature flag —
`rules`, `rollout`, `bucketBy`, `defaultValue`. The only differences are:

1. the value is a **number**, and
2. the client applies a **clamp** (`min` / `max` / `default` / `step`) after
   resolution.

So limits parallel the feature-flag code paths rather than building a second
resolution engine. Server contract (numeric sibling of the FF endpoint):

```
POST /organizations/{org_id}/config/limits/{key}/evaluate
  body   = { environment, context }
  → 200  { value: number, matchedRuleId?, rolloutBucket?, source }
           source ∈ { raw | rule | rollout | default }
  → 404  limit key not in schema
  → 400  bad context / missing environment
```

`value` is the **raw resolved number** (pre-clamp). The client clamps.

## Schema shape — `limitsSchema` + `defineLimit`

Limits are declared in a fourth tier alongside the existing three. Each entry
is a `LimitDefinition` produced by `defineLimit`, carrying the clamp metadata:

```ts
import { defineConfig, defineLimit } from '@smooai/config';

const config = defineConfig({
    limitsSchema: {
        // server resolves the raw/segmented number; the CLIENT clamps into
        // [min, max], falling back to `default`.
        agentMaxIterations: defineLimit({ default: 12, min: 1, max: 50 }),
        maxTokens: defineLimit({ default: 4096, step: 256 }),
    },
});

config.LimitKeys; // { AGENT_MAX_ITERATIONS: 'agentMaxIterations', MAX_TOKENS: 'maxTokens' }
config._limitsMeta; // runtime clamp metadata, keyed by camelCase key
```

`LimitDefinition`:

| field     | meaning                                                         |
| --------- | --------------------------------------------------------------- |
| `default` | fallback used by `getLimit()` and when resolution is non-finite |
| `min?`    | inclusive lower clamp bound                                     |
| `max?`    | inclusive upper clamp bound                                     |
| `step?`   | granularity — snap to nearest multiple _before_ clamping        |

`defineLimit` validates the metadata up front (`min <= default <= max`,
`step > 0`) so a bad schema fails at definition time, not at runtime.

### Serialization / wire format

The `serializedAllConfigSchemaJsonSchema` (the `smooai-config push` wire
format the dashboard renders) gains a fourth tier node. Each limit key becomes
a bounded JSON-Schema number so the clamp metadata travels to the server:

```json
"limitsSchema": {
  "type": "object",
  "properties": {
    "agentMaxIterations": { "type": "number", "default": 12, "minimum": 1, "maximum": 50 },
    "maxTokens":          { "type": "number", "default": 4096, "multipleOf": 256 }
  }
}
```

Limits are **not** added to `allConfigSchema` (the Str/Bool/Num resolution
map that feeds `getSync`) — their value kind is a `LimitDefinition` object, and
they never bake. They live only in `LimitKeys`, `_limitsMeta`, and the JSON
Schema tier node. This keeps the resolution chain (blob → env → http → file)
untouched.

## Client API surface

Two entry points per language, mirroring the feature-flag split
(`getFeatureFlag` sync + `evaluateFeatureFlag` async):

- **`getLimit(key): number`** — synchronous. Reads a baked/env fallback if
  present, else the schema `default`, then clamps. This is the offline / boot
  path; it never hits the network.
- **`evaluateLimit(key, context): Promise<…>`** — async, always a network call
  to the limits evaluator. Returns the raw resolved number; the tier accessors
  (`buildClientConfig`/`buildConfig`) clamp it for you, or use `clampLimit`
  directly with a `LimitDefinition`.

### TS

```ts
// ConfigClient — raw evaluate (mirrors evaluateFeatureFlag)
client.evaluateLimit(key, context?, environment?): Promise<EvaluateLimitResponse>
// EvaluateLimitResponse = { value: number; matchedRuleId?; rolloutBucket?; source }

// factory (mirrors createFeatureFlagEvaluator)
createLimitEvaluator<typeof LimitKeys>(client): (key, context?, env?) => Promise<EvaluateLimitResponse>

// pure clamp helper (client applies the schema metadata)
clampLimit(raw: unknown, def: LimitDefinition): number

// buildClientConfig / buildConfig gain a `limit` tier:
config.limit.getLimit(key): number                       // sync, clamped default
config.limit.evaluateLimit(key, ctx?, env?): Promise<ClampedLimitResult>
//   ClampedLimitResult = { value, rawValue, source, matchedRuleId?, rolloutBucket?, clamped }
```

`getClientLimit(key)` (browser) reads `NEXT_PUBLIC_LIMIT_*` / `VITE_LIMIT_*`
from the bundler env bag, mirroring `getClientFeatureFlag`. When not baked it
returns `undefined` and the tier falls back to the schema `default` — see the
rollout gap below.

### Error modes

Typed subclasses, matching the FF hierarchy (`LimitEvaluationError` base):

- `LimitNotFoundError` — 404 (limit key not in schema)
- `LimitContextError` — 400 (bad context / missing environment)
- `LimitEvaluationError` — generic non-2xx

Rust uses a `LimitEvaluationError` enum (`NotFound` / `ContextError` /
`Evaluation` / `Request`); Go a `LimitEvaluationError` struct + `LimitErrorKind`

- `errors.Is` sentinels (`ErrLimitNotFound` / `ErrLimitContext` /
  `ErrLimitServer`); .NET a `LimitEvaluationException` + `LimitErrorKind`. All
  one-for-one with the feature-flag equivalents.

### Caching

`evaluateLimit` never consults the value cache — every call hits the evaluator
(limits are context-dependent). Same policy as `evaluateFeatureFlag`.

## The clamp

`clampLimit(raw, def)` is pure and deterministic (identical logic in every
language):

1. If `raw` is not a real number (or a non-empty numeric string), OR is
   non-finite (`NaN` / `±Inf`) → use `default`. (Note: `Number(null)` /
   `Number('')` are `0`, which would slip through a naive `Number()` — the
   guard rejects them.)
2. If `step` is set, snap to the nearest multiple.
3. Clamp into `[min, max]`.

The clamp lives on the **client** by design: a stale or malicious server value
can never push a consumer outside its declared safe range, and the metadata is
authored once in the schema.

## Polyglot rollout

`evaluateFeatureFlag` is already landed in all five languages, so limits
inherit no gap there. Per-language surface:

| lang   | evaluate                                         | clamp                     |
| ------ | ------------------------------------------------ | ------------------------- |
| TS     | `client.evaluateLimit(key, ctx?, env?)`          | `clampLimit(raw, def)`    |
| Rust   | `client.evaluate_limit(key, ctx, env).await`     | `clamp_limit(raw, &spec)` |
| Python | `client.evaluate_limit(key, ctx?, env?)`         | `clamp_limit(raw, spec)`  |
| Go     | `client.EvaluateLimit(ctx, key, evalCtx, env)`   | `ClampLimit(raw, spec)`   |
| .NET   | `client.EvaluateLimitAsync(key, ctx?, env?, ct)` | `spec.Clamp(raw)`         |

Tests (schema parse / clamp / mocked evaluate call) pass in **all five**:
TS (vitest), Rust (cargo), Python (pytest), Go (go test), .NET (xunit).

### Known gaps / follow-ups

1. **Schema _declaration_ is TS-only.** Limits are declared in the consumer's
   TS `.smooai-config/config.ts` (via `defineConfig({ limitsSchema })`) and
   pushed to the config server. The polyglot runtimes **consume** limits
   (`evaluate_limit` + clamp) — they don't declare schemas — so the native
   `define_config` signatures (Rust/Go/Python/.NET) were intentionally left at
   three tiers. Adding a native `limitsSchema` tier there is a follow-up if a
   non-TS service ever needs to author (not just read) a limit.
2. **Server endpoint.** `POST /config/limits/{key}/evaluate` is documented
   here and called by the clients; wiring the route in the smooai monorepo
   backend (an alias to the same segment evaluator, typed numeric) is the
   follow-up consumer change (out of scope for this library).
3. **Bundler baking of limit defaults.** `getClientLimit` reads
   `NEXT_PUBLIC_LIMIT_*` / `VITE_LIMIT_*`, but the Next.js/Vite plugins don't
   yet emit those keys, so `getLimit()` currently returns the clamped schema
   `default`. That's the correct sync fallback (limits are live-evaluated); a
   follow-up can bake per-org defaults if a purely-offline default is needed.
4. **React `useLimitEvaluation`.** Skipped — the parallel
   `useFeatureFlagEvaluation` hook was designed in `DESIGN-segment-context.md`
   but never landed (only `useFeatureFlag` via `getValue` exists). Add
   `useLimitEvaluation` when/if `useFeatureFlagEvaluation` lands, so both stay
   symmetric.
