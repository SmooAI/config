---
'@smooai/config': minor
---

SMOODEV-1492: Add container/runtime mode to the **Go** SDK (`github.com/SmooAI/config/go/config/container`) — bringing it to parity with the TypeScript reference (SMOODEV-1490) under the five-language contract (SMOODEV-1489).

Container mode makes the HTTP config API the first-class, fail-loud path for long-lived containers (EKS/ECS) instead of the Lambda-oriented baked blob, with idiomatic Go semantics (error returns + `context.Context`, no panics on the error-returning path):

- `InitContainerConfig(ctx, opts) (*ContainerConfigHandle, error)` — validates the container env contract, mints an M2M OAuth token, and does an initial fetch so auth/network failures surface at startup (not first read). Missing/blank required env returns a typed `*ConfigBootstrapError` listing exactly which vars are missing.
- Fail-loud reads — `handle.SecretConfig`/`PublicConfig`/`FeatureFlag`: `Get(key) (value, ok, err)` returns `*ConfigKeyUnresolvedError{ Key, Env, TriedTiers }` for a required key that resolves absent (the SMOODEV-1478 CrashLoop class); `MustGet(key) (value, ok)` is the fail-loud sync analog that panics on the same. `OptionalKeys` opts specific keys out (returns the zero value, `ok=false`, no error).
- `handle.Health() ConfigHealth` and `container.ConfigHealthOf(handle)` — non-erroring status for Kubernetes readiness/liveness probes; serves last-good within the 30s cache TTL, reports `unhealthy` past hard-expiry.
- `container.SelectMode(*SelectModeInputs) string` — mode selection (explicit `SMOOAI_CONFIG_MODE=container`, blob/file present → default, or auto-select on M2M creds).
- Same defaults as every SDK: 30s cache TTL, 60s token refresh buffer, 401→invalidate→retry once. New `ConfigClient.SeedCache` / `ConfigClient.GetCachedValue` helpers back the env-tier override + last-good serving.
