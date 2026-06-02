---
'@smooai/config': minor
---

SMOODEV-1523: Add an ESO bearer-token refresher (`@smooai/config/eso-refresher` + `smooai-config-eso-refresher` bin). It re-mints the OAuth2 `client_credentials` access token on a short interval (reusing `TokenProvider`) and writes it into the ExternalSecrets bootstrap Kubernetes Secret, so ESO's webhook provider always reads a fresh, non-expired bearer. This is what lets workload secrets sync via ESO instead of being Pulumi-baked at SST deploy time — decoupling `@smooai/config` secret-value changes from the ~1h platform deploy (epic SMOODEV-1522).
