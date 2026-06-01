---
'@smooai/config': minor
---

SMOODEV-1494: Add container/runtime mode to the **Rust** SDK (`smooai_config::container`) — parity with the TypeScript reference (SMOODEV-1490) and the five-language contract (SMOODEV-1489).

Container mode makes the HTTP config API the first-class, fail-loud path for long-lived containers (EKS/ECS) instead of the Lambda-oriented baked blob:

- `init_container_config(InitContainerConfigOptions) -> Result<ContainerConfigHandle, ConfigError>` — validates the container env contract, mints an M2M OAuth token, and performs an initial config fetch so auth/network/missing-env failures surface at startup (not first read). Missing/blank required env returns `ConfigError::Bootstrap(ConfigBootstrapError { missing })` listing exactly which vars are absent.
- Fail-loud reads — `handle.secret_config()/public_config()/feature_flag()` each expose `get(key).await` and `get_sync(key)` that return `Err(ConfigError::KeyUnresolved(ConfigKeyUnresolvedError { key, env, tried_tiers }))` for a required key that resolves absent, instead of silently returning `Ok(None)` (the SMOODEV-1478 CrashLoop class). `optional_keys` opts specific keys out (returning `Ok(None)`).
- `config_health(&handle)` / `handle.health() -> ConfigHealth` — non-failing status for Kubernetes readiness/liveness probes; serves last-good within the 30s cache TTL, reports `Unhealthy { reason }` past hard-expiry.
- `select_mode(Option<SelectModeInputs>) -> Mode` — mode selection (explicit `SMOOAI_CONFIG_MODE=container`, blob/file present → `Default`, or auto-select on M2M creds).
- Typed errors `ConfigBootstrapError`, `ConfigKeyUnresolvedError`, and `ConfigTier` (`blob|env|http|file`) mirror the TS shapes/fields; constants `DEFAULT_CACHE_TTL` (30s) and `DEFAULT_TOKEN_REFRESH_BUFFER_SECONDS` (60). On a 401 the token is invalidated and the request retried once.

README gains a "Container / Runtime Mode" section linking the shared `docs/Container-Runtime-Mode.md`.
