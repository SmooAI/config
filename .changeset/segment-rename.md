---
'@smooai/config': patch
---

Docstring-only rename: "cohort" → "segment" across TS/Python/Rust/Go feature-flag evaluator surfaces. The underlying API (`evaluateFeatureFlag(key, context)`, `createFeatureFlagEvaluator`) is unchanged; only prose and JSDoc/comments pick up the more industry-standard "segment" terminology. Design doc renamed `DESIGN-cohort-context.md` → `DESIGN-segment-context.md`.
