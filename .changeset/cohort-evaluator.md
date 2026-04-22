---
'@smooai/config': minor
---

SMOODEV-624: Add cohort-aware feature-flag evaluator client API. New `ConfigClient.evaluateFeatureFlag(key, context?, environment?)` async method hits the server-side evaluator endpoint so cohort rules (percentage rollout, attribute matching, bucketing) actually fire. New `createFeatureFlagEvaluator<FlagKeys>(client)` factory in `@smooai/config/client` mirrors the existing `createFeatureFlagChecker` shape for typed keys. Typed errors: `FeatureFlagEvaluationError`, `FeatureFlagNotFoundError`, `FeatureFlagContextError` — catch once, map to 400/404/5xx cleanly. Existing sync `getFeatureFlag` unchanged — callers who don't need cohorts keep the cache-read path. TypeScript only in this release; Python/Rust/Go parity follows.
