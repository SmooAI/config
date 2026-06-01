---
'@smooai/config': minor
---

SMOODEV-1491: Add container/runtime mode to the **.NET** SDK (`SmooAI.Config.Container`) — brings the C# client to parity with the TypeScript reference (SMOODEV-1490) of the five-language contract (SMOODEV-1489).

Container mode makes the HTTP config API the first-class, fail-loud path for long-lived containers (EKS/ECS) instead of the Lambda-oriented baked blob:

- `ContainerConfig.InitContainerConfigAsync(options)` — validates the container env contract, mints an M2M OAuth token, and does an initial fetch-all-values so auth/network failures surface at startup (not first read). Missing/blank required env throws a typed `ConfigBootstrapException` carrying `Missing` (the exact env var names).
- Fail-loud reads — `SecretConfig.GetAsync`/`GetSync` (and the public/flag analogs) throw `ConfigKeyUnresolvedException { Key, Env, TriedTiers }` for a required key that resolves absent, instead of silently returning `null` (the SMOODEV-1478 CrashLoop class). `OptionalKeys` opts specific keys out. Per the TS design fork, all schema keys are required by default.
- `ContainerConfig.Health(handle)` / `handle.Health()` — non-throwing `ConfigHealth { Status, Reason }` for Kubernetes readiness/liveness probes; serves last-good within the 30s cache TTL, reports `unhealthy` past hard-expiry.
- `ContainerConfig.SelectMode(inputs)` — mode selection (explicit `SMOOAI_CONFIG_MODE=container`, blob/file present → default, or auto-select on M2M creds).
- Same exact `SMOOAI_CONFIG_*` env contract, env-over-http tier precedence, `UPPER_SNAKE_CASE(key)` env overrides, 30s cache TTL, 60s token refresh buffer, and 401 → refresh → retry as the TypeScript reference.
- README "Container / Runtime Mode" section linking the shared `docs/Container-Runtime-Mode.md`.
