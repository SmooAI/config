---
'@smooai/config': minor
---

SMOODEV-1490: Add container/runtime mode (`@smooai/config/container`) — the TypeScript reference implementation of the five-language parity contract (SMOODEV-1489).

Container mode makes the HTTP config API the first-class, fail-loud path for long-lived containers (EKS/ECS) instead of the Lambda-oriented baked blob:

- `initContainerConfig(options?)` — validates the container env contract, mints an M2M OAuth token, and does an initial config fetch so auth/network failures surface at startup (not first read). Missing/blank required env throws a typed `ConfigBootstrapError` listing exactly which vars are missing.
- Fail-loud reads — `secretConfig.get`/`getSync` (and public/flag analogs) throw `ConfigKeyUnresolvedError { key, env, triedTiers }` for a required key that resolves absent, instead of silently returning `undefined` (the SMOODEV-1478 CrashLoop class). `optionalKeys` opts specific keys out.
- `configHealth()` / `handle.health()` — non-throwing status for Kubernetes readiness/liveness probes; serves last-good within the 30s cache TTL, reports `Unhealthy` past hard-expiry.
- `selectMode()` — mode selection (explicit `SMOOAI_CONFIG_MODE=container`, blob/file present → default, or auto-select on M2M creds).
- New canonical doc `docs/Container-Runtime-Mode.md` with the env contract, an ExternalSecret (External Secrets Operator) recipe, and a readiness-probe example.
