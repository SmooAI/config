---
'@smooai/config': minor
---

Add `useFeatureFlagEvaluation` and `useLimitEvaluation` React hooks, and close the
`featureFlag` tier's missing `evaluate`.

`evaluate_feature_flag(context)` did NOT stall after TypeScript — it shipped in
all four target languages plus .NET, Kotlin and Swift, with an identical wire
contract. What actually stalled was one item from step 1 of the rollout: the
React hook. `DESIGN-limits.md` then deferred `useLimitEvaluation` explicitly
_behind_ it, so a single missing hook blocked two. Both now land, sharing one
engine so they cannot drift.

`buildClientConfig`'s `featureFlag` tier gains `evaluate`, matching the `limit`
tier's `evaluateLimit` — the later limits work had overtaken the feature-flag
surface it was modelled on.

`DESIGN-segment-context.md` is re-grounded: its "blocked by TS design
ratification" heading was stale by seven languages.
