---
'@smooai/config': minor
---

SMOODEV-1493: Python SDK parity for container/runtime mode — brings `smooai_config.container` to behavioral parity with the TypeScript reference (SMOODEV-1490) under the five-language contract (SMOODEV-1489).

Container mode makes the HTTP config API the first-class, fail-loud path for long-lived containers (EKS/ECS) instead of the Lambda-oriented baked blob:

- `init_container_config(*, schema, ...)` — validates the container env contract (`SMOOAI_CONFIG_API_URL` / `CLIENT_ID` / `CLIENT_SECRET` / `ORG_ID` / `ENV`), mints an M2M OAuth token, and does an initial config fetch so auth/network failures surface at startup (not first read). Missing/blank required env raises a typed `ConfigBootstrapError` listing exactly which vars are missing. Explicit kwargs override env vars; with an injected `config_client` only `SMOOAI_CONFIG_ENV` is env-required.
- Fail-loud reads — `secret_config.get` / `get_sync` (and `public_config` / `feature_flag` analogs) raise `ConfigKeyUnresolvedError { key, env, tried_tiers }` for a required key that resolves absent, instead of silently returning `None` (the SMOODEV-1478 CrashLoop class). `optional_keys` opts specific keys out. Per the TS reference's design fork, all schema-declared keys are required by default.
- `config_health(handle)` / `handle.health()` — non-throwing `ConfigHealth` status for Kubernetes readiness/liveness probes; serves last-good within the 30s cache TTL, reports unhealthy past hard-expiry.
- `select_mode()` — mode selection (explicit `SMOOAI_CONFIG_MODE=container`, blob/file present → default, or auto-select on M2M creds).
- Constants `DEFAULT_CACHE_TTL_MS` (30000) and `DEFAULT_TOKEN_REFRESH_BUFFER_SECONDS` (60), and a README "Container / Runtime Mode" section linking the shared `docs/Container-Runtime-Mode.md`.

Extends the existing `ConfigClient` / `TokenProvider` plumbing (adds a read-only `ConfigClient.get_cached_value`); does not fork a parallel path and leaves the blob/Lambda path untouched.
