---
'@smooai/config': patch
---

SMOODEV-959: Port the segment-aware feature-flag evaluator to the .NET SDK so it reaches parity with TS / Python / Rust / Go. `SmooConfigClient.EvaluateFeatureFlagAsync(key, context, environment)` POSTs to `/organizations/{orgId}/config/feature-flags/{key}/evaluate` and returns an `EvaluateFeatureFlagResponse` carrying the resolved value plus `matchedRuleId`, `rolloutBucket`, and `source` (`raw` / `rule` / `rollout` / `default`). HTTP 404 / 400 / 5xx surface as a typed `FeatureFlagEvaluationException` with a `Kind` enum so callers can branch without parsing messages.

Also wires the existing typed `ConfigKey<T>` handle: feature-flag-tier keys get `EvaluateAsync(client, context)` (returns the deserialized value) and `EvaluateRawAsync(client, context)` (returns the full envelope). Calling either on a non-FeatureFlag key throws `InvalidOperationException`.
