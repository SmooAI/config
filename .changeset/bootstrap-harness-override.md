---
'@smooai/config': minor
---

`bootstrapFetch` now honors a `SMOOAI_HARNESS_<KEY>` env override (e.g.
`SMOOAI_HARNESS_DATABASE_URL`, `SMOOAI_HARNESS_RLS_DATABASE_URL`) that
short-circuits the HTTP fetch entirely — the same §15 escape hatch
`packages/db` `drizzleClient.resolveDbUrl` already honors at runtime. This makes
the prod-script override work uniformly across ALL cold-start config consumers
(db-migrate and friends), not just the runtime drizzle client. Previously
`bootstrapFetch` ignored the override and fell through to `env='development'`
when no SST stage was set, silently fetching the wrong environment's value.
