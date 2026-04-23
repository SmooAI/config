# SMOODEV-624 — Segment-aware feature-flag evaluation client API

> Design notes for adding segment / context-aware feature-flag evaluation to
> the `@smooai/config` client libraries (TS, Python, Rust, Go). Background:
> SMOODEV-614 already landed the server-side evaluator endpoint and the
> schema-level segment rule definitions (`$cohort` envelope, `rules`,
> `defaultValue`, `bucketBy`, `rollout`). The client side currently
> only supports fetching static feature-flag values from cache; this doc
> specifies how to expose cohort-evaluated values.

## Current state

- TS client: `getFeatureFlag(key) -> boolean` (sync, reads local cache).
  Lives in `src/client/index.ts` via `createFeatureFlagChecker()`.
- Python: `ConfigClient.get_feature_flag(key) -> Any | None` (sync, cache).
- Rust: `ConfigManager::get_feature_flag(&self, key) -> Result<Option<Value>>`.
- Go: `(*ConfigManager).GetFeatureFlag(key) (any, error)`.
- Server evaluator endpoint is live at
  `POST /organizations/{org_id}/config/feature-flags/{key}/evaluate`, consumes
  `{ environment, context: Record<string, unknown> }`, returns
  `{ value, matchedRuleId?, rolloutBucket?, source }` where
  `source ∈ {raw | rule | rollout | default}`.

## Design: Option A — two distinct methods (recommended)

**Keep `getFeatureFlag(key)` unchanged. Add a second method
`evaluateFeatureFlag(key, context?)` that is async and does a network call.**

Rationale:

- `getFeatureFlag` is sync today; callers across the codebase rely on that
  (no `await` at every call site). Making it async would be a breaking
  change for every caller. We don't have a deprecation runway.
- Segment evaluation is fundamentally a network call — the server does the
  rule matching, rollout bucketing, and audit logging. Hiding the network
  behind a name that used to be sync is a footgun.
- The evaluator response is richer than a boolean (it returns
  `matchedRuleId`, `rolloutBucket`, `source`). A separate method earns its
  own return type.

### TS surface

```ts
// src/platform/client.ts — on ConfigClient
async evaluateFeatureFlag<K extends string = string>(
    key: K,
    context?: Record<string, unknown>,
): Promise<EvaluateFeatureFlagResponse> {
    // POST /organizations/:org_id/config/feature-flags/:key/evaluate
    //   body = { environment, context }
    // Returns: { value, matchedRuleId?, rolloutBucket?, source }
}

// src/client/index.ts — factory alongside createFeatureFlagChecker
export function createFeatureFlagEvaluator<T extends Record<string, string>>(
    client: ConfigClient,
): (key: T[keyof T], context?: Record<string, unknown>) => Promise<EvaluateFeatureFlagResponse>;
```

### Error modes

Throw typed errors — matches codebase convention (no tagged unions).

- `FeatureFlagNotFoundError` — server returned 404 (flag key not in schema)
- `FeatureFlagContextError` — server returned 400 (missing `environment`,
  bad context shape)
- `FeatureFlagEvaluationError` — generic 5xx wrapper

All extend `SmooaiConfigError`.

### React hook

```ts
// src/react/hooks.ts
export function useFeatureFlagEvaluation<K extends string>(
    key: K,
    context?: Record<string, unknown>,
): { value: unknown; source?: string; matchedRuleId?: string; isLoading: boolean; error?: Error };
```

Powered by `@tanstack/react-query` (already a peer dep). Cache key
includes canonicalized context so toggling context re-fetches.

### Caching behavior

- `evaluateFeatureFlag` does NOT consult the cache. Every call hits the
  server by default.
- Optional opt-in: `client.evaluateFeatureFlag(key, context, { cache: '60s' })`
  with an in-memory LRU keyed by `(key, stableStringify(context))`. v2.
- React hook defers to `react-query`'s stale-while-revalidate — callers
  pass `staleTime` / `gcTime` via the hook's options.

### Context shape guidance

Context is `Record<string, unknown>`. Server only reads keys that the
specific flag's segment rules reference (e.g. `userId`, `tenantId`,
`plan`, `country`, `$cohort.bucketBy`). Clients can over-provide context
freely — unused keys are ignored.

Keep values JSON-serializable. Server hashes `bucketBy` values by their
string representation, so numbers and booleans bucket stably across
client rebuilds.

## Language parity (blocked by TS design ratification)

### Python

```python
async def evaluate_feature_flag(
    self, key: str, context: dict[str, Any] | None = None
) -> EvaluateFeatureFlagResponse: ...
```

Pydantic model for response. Error classes: `FeatureFlagNotFoundError`,
`FeatureFlagContextError`, `FeatureFlagEvaluationError`, all inheriting
from existing `SmooaiConfigError`.

### Rust

```rust
pub async fn evaluate_feature_flag(
    &self,
    key: &str,
    context: Option<HashMap<String, serde_json::Value>>,
) -> Result<EvaluateFeatureFlagResponse, SmooaiConfigError>;
```

### Go

```go
type EvaluateFeatureFlagResponse struct {
    Value          any     `json:"value"`
    MatchedRuleID  *string `json:"matchedRuleId,omitempty"`
    RolloutBucket  *int    `json:"rolloutBucket,omitempty"`
    Source         string  `json:"source"`
}

func (m *ConfigManager) EvaluateFeatureFlag(
    ctx context.Context,
    key string,
    context map[string]any,
) (*EvaluateFeatureFlagResponse, error)
```

## Alternatives considered

**Option B — replace `getFeatureFlag` with async.** Rejected: breaking
change, no runway. Every caller adds `await`, and most don't need the
network round-trip.

**Option C — overloaded `getFeatureFlag(key, context?)` with conditional
return type (sync or async depending on args).** Rejected: fragile TS
types, hard to mirror in Python/Rust/Go, magic behavior confuses readers.

## Rollout order

1. TS impl — client method + factory + React hook + unit tests + docs.
2. Python parity (in its own PR, same ticket).
3. Rust parity.
4. Go parity.
5. E2E test in `packages/backend/e2e/config-sdk.e2e.test.ts` covering all
   four languages against a seeded cohort-enabled flag.

Each language lands independently; nothing breaks existing callers since
the new method is purely additive.
