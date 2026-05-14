---
'@smooai/config': patch
---

SMOODEV-993: The CLI now honors `SMOOAI_CONFIG_CLIENT_ID` / `SMOOAI_CONFIG_CLIENT_SECRET` / `SMOOAI_CONFIG_ORG_ID` / `SMOOAI_CONFIG_API_URL` / `SMOOAI_CONFIG_AUTH_URL` (legacy `SMOOAI_CONFIG_API_KEY` and `SMOOAI_AUTH_URL` accepted) when those env vars are fully populated. The env-var-supplied OAuth credentials take precedence over `~/.smooai/credentials.json` so `smooai-config list/get/set` etc. hit the same org as every other tool in the same shell — matches how `scripts/bake-config-dev.ts`, `smoo-secrets/push-secrets.ts`, and the prod deploy baker already authenticate. Falls back to `~/.smooai/credentials.json` unchanged when env vars are absent. Fixes the silent org mismatch where the CLI could query a totally different account than the surrounding scripts (caused an entire investigation cycle to chase a "missing secrets" mirage that was actually just wrong-org auth).
