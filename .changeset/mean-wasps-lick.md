---
'@smooai/config': patch
---

**SMOODEV-602** — CLI + runtime client fixes surfaced while dogfooding the
three-tier schema in the smooai monorepo:

- `smooai-config diff/push/pull` no longer fails with
  `ERR_UNKNOWN_FILE_EXTENSION` on `.smooai-config/config.ts`. The schema
  loader used a bare `await import(tsPath)` which Node can't resolve for
  `.ts` files — switched to `tsImport` from `tsx/esm/api` (tsx is already
  a runtime dep of this package), so the CLI works out of the box in any
  project that declares its schema in TypeScript.
- Both HTTP paths (`src/platform/client.ts` runtime client and
  `src/cli/utils/api-client.ts` CLI client) now route through
  `@smooai/fetch` — which dogfoods our own resilient-fetch package for
  retries, 429 Retry-After honoring, and clearer error surfaces.
  `@smooai/fetch` was already a dependency; it just wasn't being used.

No API-surface change. Drop-in patch release.
