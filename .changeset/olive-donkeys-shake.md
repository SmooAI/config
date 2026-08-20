---
'@smooai/config': patch
---

Security: close all 155 open Dependabot advisories across npm, PyPI and Go.

The secrets library had no `.github/dependabot.yml` and automated security fixes
switched off, so nothing ever opened an update PR and advisories accumulated
unchecked. Bumped the direct dependencies carrying the transitive vulnerabilities
(`@kubernetes/client-node`, `@smooai/{fetch,logger,utils}`, `effect`, `valibot`,
`ajv`, `ink`, `vite`, `vitest`, `jsdom`, `tsup`, `@changesets/cli`), pinned the
three remaining transitives via `pnpm.overrides` (`esbuild`, `next`, `uuid`),
upgraded `python/uv.lock` (`cryptography` 46 → 50, `idna`, `pytest`, `pygments`)
and `github.com/buger/jsonparser` 1.1.1 → 1.6.1. Added a grouped `dependabot.yml`
covering all eight ecosystems so this cannot silently re-accumulate.
