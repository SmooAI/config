---
'@smooai/config': major
---

SMOODEV-974: `ConfigClient` (TypeScript runtime) now exchanges OAuth `client_credentials` for a JWT and uses **that** JWT as the Bearer token on `/config/values` calls, matching the .NET `SmooConfigClient`, the in-package `bootstrap`, and the CLI.

**Breaking — all four broken language clients in this package previously sent the raw API key as the Bearer token, which the backend rejects with 401 because it expects a JWT.** Live feature flag fetches and runtime config reads were therefore silent failures across TypeScript, Python, Go, and Rust. This release fixes TypeScript; Python / Go / Rust ship in follow-up tickets (SMOODEV-9xx).

**TypeScript migration**:

- Set both `SMOOAI_CONFIG_CLIENT_ID` **and** `SMOOAI_CONFIG_CLIENT_SECRET` (or the legacy `SMOOAI_CONFIG_API_KEY`) on every consumer Lambda / process. The runtime SDK now requires both.
- `new ConfigClient({...})` now requires `clientId` in addition to `clientSecret` (or `apiKey`). Constructing without `clientId` throws.
- `apiKey` is preserved as a deprecated alias for `clientSecret`. Source-level code that passes `apiKey` continues to compile, but the value is now treated as the OAuth client secret (which is what it always was in the AuthDynamoTable).
- New exported class `TokenProvider` in `@smooai/config/platform` — mirrors `SmooAI.Config.OAuth.TokenProvider` (mint, cache, 60s refresh window). Pass `new TokenProvider({...})` via the `tokenProvider` option to override caching or for testing.

**No-change consumers**:

- `bootstrap` (`@smooai/config/bootstrap`) and the CLI were already doing the OAuth exchange — their behavior is unchanged.
- `.NET` `SmooConfigClient` was already correct — unchanged.
- Schema/build/manage tooling is unchanged.

**Behavior change to be aware of**:

- The TS runtime now makes an additional `POST /token` request on cold start (and after token expiry / 401). The JWT is cached in-memory for the lifetime of the `ConfigClient` instance, refreshed 60s before expiry. On a 401 response from `/config/values` or `/evaluate`, the cached token is invalidated and the call is retried once.
