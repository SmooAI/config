# `@smooai/config` — Container/Runtime Mode (language-parity spec)

**Epic:** SMOODEV-1489 · **Status:** authoritative contract for the TS/dotnet/go/python/rust implementations.

## Why

`@smooai/config` has four resolution tiers: **blob → env → HTTP → file**. The blob tier (an encrypted config bundle baked into a Lambda layer / image at deploy time, decrypted with a key delivered separately) is the blessed path for **Lambda**. It is the *wrong* default for long-lived **containers** (EKS/ECS): the per-build blob key has to be delivered to the pod, and when it isn't, resolution silently falls through to the (absent) file tier and returns **`undefined`** for a required secret. A real incident (SMOODEV-1478): a container got `undefined` for `STRIPE_API_KEY`, a module-load `new Stripe(undefined)` threw, the process exited 0 before `listen()`, and the service CrashLooped — with the root cause buried under unrelated log noise.

Container/Runtime Mode makes the **HTTP tier the blessed, first-class path for containers**, authenticated with an OAuth2 `client_credentials` (M2M) token, **fail-loud** so a missing required value is an immediate, clear error (not a silent `undefined`), and **documented** with a canonical Kubernetes/ExternalSecret recipe.

This must be implemented with **identical semantics and env contract across all five language SDKs**. Idioms differ; behavior does not.

## 1. Environment contract (identical in every language)

| Env var | Required | Meaning |
| --- | --- | --- |
| `SMOOAI_CONFIG_MODE` | no | `container` selects this mode explicitly. Also auto-selected when `SMOOAI_CONFIG_CLIENT_ID` + `SMOOAI_CONFIG_CLIENT_SECRET` are set and no blob/file is present (see §2). |
| `SMOOAI_CONFIG_API_URL` | yes (container) | Config API base URL (e.g. `https://api.smoo.ai`). |
| `SMOOAI_CONFIG_AUTH_URL` | no | OAuth issuer base URL. Default `https://auth.smoo.ai`. |
| `SMOOAI_CONFIG_CLIENT_ID` | yes (container) | M2M OAuth client id. |
| `SMOOAI_CONFIG_CLIENT_SECRET` | yes (container) | M2M OAuth client secret. (Legacy alias `SMOOAI_CONFIG_API_KEY` accepted for the secret, deprecated.) |
| `SMOOAI_CONFIG_ORG_ID` | yes (container) | Organization id whose config to fetch. |
| `SMOOAI_CONFIG_ENV` | yes (container) | Environment name (e.g. `production`). |

These names already exist in the TS `ConfigClient`/`bootstrap`; the other languages MUST adopt the exact same names (no per-language variants).

## 2. Mode selection

Resolution order for picking a mode at init:
1. If `SMOOAI_CONFIG_MODE=container` → **container mode** (HTTP-primary). The blob/file tiers are disabled; env tier still consulted first for individual overrides (an explicitly-set process env var wins, matching existing tier order's `env` precedence over `http`).
2. Else if a blob/file source is present → existing behavior (Lambda/local), unchanged.
3. Else if `SMOOAI_CONFIG_CLIENT_ID` + `SMOOAI_CONFIG_CLIENT_SECRET` + `SMOOAI_CONFIG_API_URL` are all set → **container mode** (auto). Emit one info log that container mode was auto-selected.
4. Else → existing default behavior.

Container mode MUST NOT silently degrade to the file tier. If it's selected and the HTTP tier can't be constructed (missing required env from §1), it fails per §3 at bootstrap.

## 3. Fail-loud semantics (the core value-add)

- **Bootstrap validation:** `initContainerConfig()` (§4) validates that all container-required env (§1) is present and well-formed. Missing/blank → throw a typed `ConfigBootstrapError` listing exactly which vars are missing. No partial init.
- **Required-secret resolution:** a `get`/`getSecret` for a key that the schema marks **required** and that resolves to absent across the active tiers → throw a typed `ConfigKeyUnresolvedError{ key, env, triedTiers }`. NEVER return null/undefined/empty for a required key. (Optional keys may still return the language's "absent" value.)
- **Sync getters** (`getSync` analogs) keep being available only for values guaranteed present in the active mode; in container mode a `getSync` for an unresolved required key throws the same `ConfigKeyUnresolvedError` rather than returning absent. This directly closes the SMOODEV-1478 / SMOODEV-1135 silent-`undefined` class.
- Errors must carry enough context to act on (key, env, mode, tiers tried, and for bootstrap the missing env list). No generic messages.

## 4. Public API (idiomatic per language, identical semantics)

Each SDK exposes:
- **`initContainerConfig(options?) -> handle/instance`** — explicit container-mode bootstrap. Validates env (§3), constructs the M2M token provider + HTTP config client, performs an initial token mint + config fetch so failures surface at startup (not first-read). Options mirror the env contract (overrides for testing/embedding). Async where the language has async; blocking-with-explicit-timeout where idiomatic (e.g. go/rust may expose `InitContainerConfig(ctx)`).
- **`configHealth() -> Healthy | Unhealthy{reason}`** — cheap check that the active config source is usable (token valid/refreshable + last fetch succeeded). Intended for Kubernetes **readiness/liveness probes** and startup gates. Must not throw; returns a status.
- The existing typed accessors (`secretConfig.get`, `publicConfig.get`, `featureFlag.get` and language analogs) gain the §3 fail-loud behavior when running in container mode.

A reference HTTP server example exposing `/healthz/config` from `configHealth()` SHOULD ship per language (or be documented) so container readiness probes are turnkey.

## 5. Caching / refresh (parity)

- Token: cached, proactively refreshed before expiry (existing TS `TokenProvider` does `refreshBufferSeconds`, default 60s). On a 401, invalidate + retry once. Same in every language.
- Config values: cached with a TTL (TS default `cacheTtlMs: 30_000`). Same default TTL (30s) everywhere. A background refresh failure does NOT flip a previously-healthy value to unresolved; it logs and serves the last good value until TTL hard-expiry, at which point `configHealth()` reports `Unhealthy`.

## 6. Docs + Kubernetes/ESO recipe (ships with the feature)

A single canonical doc (this file's companion, `docs/Container-Runtime-Mode.md`) covering:
- The env contract (§1) and how to set it.
- A complete **ExternalSecret (External Secrets Operator)** example sourcing `SMOOAI_CONFIG_CLIENT_ID/SECRET` from the cluster's backing store (e.g. AWS Secrets Manager), plus a `ConfigMap`/`Deployment` env snippet for the non-secret vars.
- A readiness-probe example wired to `configHealth()` / `/healthz/config`.
- Explicit guidance: **containers use container mode, not the baked blob.** A short "why not the blob in a container" note linking SMOODEV-1478.

Each language README links this doc and shows the language's `initContainerConfig` + health snippet.

## 7. Parity requirements (definition of done per language ticket)

For TS (SMOODEV-1490, reference) then dotnet/go/python/rust (1491-1494):
1. `initContainerConfig` + `configHealth` + the typed errors (`ConfigBootstrapError`, `ConfigKeyUnresolvedError`), exact §1 env names, §2 mode selection, §3 fail-loud, §5 caching.
2. Tests: bootstrap-missing-env throws and lists the missing vars; required-key-unresolved throws (not absent); optional-key-absent returns absent; happy-path fetch+cache; 401→refresh→retry; `configHealth` healthy/unhealthy.
3. README section + the shared `docs/Container-Runtime-Mode.md` (authored once, referenced by all).
4. Changeset / version bump per the language toolchain; CHANGELOG entry referencing SMOODEV-1489.
5. **Behavioral parity check:** the same env + same server state produces the same resolved values and the same error types/conditions in every SDK. Where a language already has partial plumbing (TS `ConfigClient`/`bootstrap`; dotnet/go/python/rust analogs), extend it — do not fork a parallel path.

## Non-goals
- Changing the blob/Lambda path (untouched; still the Lambda default).
- The voice/EKS wiring itself (that's SMOODEV-1495, after this epic).
