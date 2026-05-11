---
'@smooai/config': minor
---

SMOODEV-880: Add `@smooai/config/bootstrap` cold-start fetch helper across all five SDKs

Adds a lightweight, dependency-free entry point for reading a single config value
via plain HTTP — OAuth `client_credentials` exchange + `GET /organizations/{orgId}/config/values`
with per-process per-env caching. Designed for deploy scripts, container entry-points,
and other cold-start contexts where importing the full SDK is too heavy or pulls in
a transitive dependency that breaks the host runtime.

Public surface per language:

- **TypeScript**: `import { bootstrapFetch } from '@smooai/config/bootstrap'` — `bootstrapFetch(key, { environment? })`
- **Python**: `from smooai_config.bootstrap import bootstrap_fetch` — `bootstrap_fetch(key, environment=None)`
- **Go**: `import ".../go/config/bootstrap"` — `bootstrap.Fetch(ctx, key, bootstrap.WithEnvironment(...))`
- **Rust**: `use smooai_config::bootstrap_fetch` — `bootstrap_fetch(key, environment).await`
- **.NET**: `using SmooAI.Config.Bootstrap` — `Bootstrap.FetchAsync(key, new BootstrapOptions { Environment = ... })`

Each implementation reads creds from `SMOOAI_CONFIG_{API_URL,AUTH_URL,CLIENT_ID,CLIENT_SECRET,ORG_ID}`
(legacy `SMOOAI_CONFIG_API_KEY` and `SMOOAI_AUTH_URL` accepted), auto-detects the
environment from `SST_STAGE` / `NEXT_PUBLIC_SST_STAGE` / `SST_RESOURCE_App` JSON /
`SMOOAI_CONFIG_ENV`, and caches the values map per-env so repeated reads in the
same process avoid the round-trip. None of the implementations import anything else
from the SDK or pull in non-stdlib dependencies beyond what the crate/package already requires.
