# Mobile Runtime Mode — language-parity spec

> Status: authoritative parity contract for the **mobile** SDKs (Swift `/swift`,
> Kotlin `/kotlin`). Sibling of `Container-Runtime-Mode-Spec.md`. Defined by
> ADR-074 in the smooai monorepo (`docs/Decisions/ADR-074-mobile-first-class-config-swift-kotlin.md`).

## 1. Why mobile is its own mode

Mobile binaries are attacker-owned territory and can never hold M2M client
credentials, so none of the existing tiers apply unchanged:

| Existing mode                              | Why it doesn't fit                                      |
| ------------------------------------------ | ------------------------------------------------------- |
| Default chain (`blob → env → http → file`) | `env`/`file` don't exist on device; `http` requires M2M |
| Container mode (`env → http`)              | same                                                    |

Mobile mode is defined by **two channels**, both scoped to the **platform
(master) org** — the app is the platform's app; signed-in users belong to
_their_ orgs, which ride along only as evaluation context:

1. **Baked public config** (build time): CI — which legitimately holds M2M
   creds — fetches the master org's values and ships the **public partition
   only** inside the app as **plaintext JSON** (`{"values": {...}}`, the exact
   shape of the `GET /config/app/values` response). No encryption: the bundle
   never contains secrets, and encrypting public data against the binary's
   owner is theater.
2. **Live flags + limits** (runtime): never baked (flags must flip without an
   app-store release). Evaluated over HTTP with the **end-user bearer token**
   (Supabase user JWT) against the app-config surface.

## 2. Server surface (implemented in the smooai monorepo, SMOODEV-2379)

Base URL default: `https://api.smoo.ai`. Auth: `Authorization: Bearer <user JWT>`
(M2M JWTs also accepted). The org is pinned server-side — no org id on the wire.

- `GET /config/app/values?environment={env}` → `{ "values": { key: value } }`
  (public tier only, enforced server-side)
- `POST /config/app/feature-flags/{key}/evaluate` body
  `{ "environment": "...", "context": { ... } }` →
  `{ "value", "source", "matchedRuleId"?, "rolloutBucket"? }`
- `POST /config/app/limits/{key}/evaluate` — same wire shape, numeric value

The server stamps the authenticated caller's `userId` over any client-supplied
`userId` in context (rollout buckets can't be gamed). Secret-tier resolution is
structurally impossible on this surface.

## 3. Required client behavior (definition of done)

Every mobile SDK MUST implement, with tests proving each row:

| #   | Behavior                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Load the baked bundle (`{"values": ...}`) from a caller-supplied location; missing bundle is not an error                          |
| 2   | `publicValue(key)`: refreshed-or-cached map wins over bundle; bundle is the floor; resolves **synchronously, offline**             |
| 3   | `refreshPublicValues()`: GET the values endpoint, persist to the offline cache; failure throws and leaves prior values intact      |
| 4   | `evaluateFlag(key, context, default)`: live evaluate → last-cached value → caller default; **never throws**                        |
| 5   | `evaluateLimit(key, context, default, min?, max?)`: same chain, then client-side clamp to `[min, max]` (ADR-066)                   |
| 6   | Raw `evaluate*Value` variants that throw, for callers who need `source`/`matchedRuleId`/`rolloutBucket`                            |
| 7   | Bearer token supplied by an async caller-provided provider; requests without a token still fire (server rejects; chain falls back) |
| 8   | Offline cache: plain JSON (public data only), survives process restarts                                                            |
| 9   | Zero third-party dependencies (platform HTTP stack: URLSession / Ktor-with-injected-engine)                                        |
| 10  | Transport injectable for tests (session/engine), mirroring the consuming apps' stub patterns                                       |

## 4. Non-goals

- No secret tier, ever. No env tier, no file tier, no ESO.
- No client-side rule evaluation — segments/rollouts are server-evaluated
  (unlike the server SDKs' local `evaluateFlag`), because the rule set is the
  platform's and must not ship to devices.
- No write surface.

## 5. Implementations

| Language | Path                          | Status       |
| -------- | ----------------------------- | ------------ |
| Swift    | `/swift` (SPM `SmooAIConfig`) | SMOODEV-2380 |
| Kotlin   | `/kotlin`                     | SMOODEV-2381 |
