# ESO Bearer-Token Refresher

`@smooai/config/eso-refresher` (bin `smooai-config-eso-refresher`) — SMOODEV-1523, epic SMOODEV-1522.

## Problem

The [ExternalSecrets Operator](https://external-secrets.io) (ESO) `webhook` provider authenticates to the `@smooai/config` HTTP API (`api.smoo.ai`) with a **static** bearer token it reads from a Kubernetes Secret (`external-secrets/smooai-config-bootstrap`, key `bearer-token`).

But `@smooai/config` issues short-lived OAuth2 `client_credentials` JWTs (~1h TTL). A static token therefore expires within the hour and every ESO sync silently begins to 401. That is precisely why workload secrets (litellm, voice, api-prime) were instead **Pulumi-baked** into Kubernetes Secrets at SST deploy time (SMOODEV-1347) — which couples _every_ secret-value change to a ~1h platform deploy.

## What the refresher does

A small sidecar/Deployment that, on a short interval (default 15m, well under the JWT TTL):

1. Re-mints a fresh access token using the same `TokenProvider` the runtime SDK uses (`invalidate()` then `getAccessToken()` so the token always has a near-full TTL ahead).
2. Patches `bearer-token` in the bootstrap Secret via a JSON merge-patch.

ESO then always reads a fresh bearer. A `th config set <key> <value> --environment=production` becomes live on ESO's next `refreshInterval` plus a `kubectl rollout restart` of the consuming workload — **no platform deploy**.

The initial mint+write is awaited at startup and **fails loud** (non-zero exit → visible crash-loop) on misconfiguration. Later loop failures are logged and retried on the next tick — the existing Secret token is still valid for the remainder of its TTL.

## Env contract

| Var                                   | Required | Default                   | Purpose                                                        |
| ------------------------------------- | -------- | ------------------------- | -------------------------------------------------------------- |
| `SMOOAI_CONFIG_CLIENT_ID`             | yes      | —                         | M2M OAuth client id (config-read scoped)                       |
| `SMOOAI_CONFIG_CLIENT_SECRET`         | yes      | —                         | M2M OAuth client secret (legacy alias `SMOOAI_CONFIG_API_KEY`) |
| `SMOOAI_CONFIG_AUTH_URL`              | no       | `https://auth.smoo.ai`    | OAuth issuer base URL                                          |
| `SMOOAI_ESO_SECRET_NAMESPACE`         | no       | `external-secrets`        | Bootstrap Secret namespace                                     |
| `SMOOAI_ESO_SECRET_NAME`              | no       | `smooai-config-bootstrap` | Bootstrap Secret name                                          |
| `SMOOAI_ESO_SECRET_KEY`               | no       | `bearer-token`            | Data key to write                                              |
| `SMOOAI_ESO_REFRESH_INTERVAL_SECONDS` | no       | `900`                     | Re-mint + write interval                                       |

`orgId` / `environment` are **not** needed — those are query params ESO supplies when it calls the config API; the token itself is org-agnostic.

## Deployment

- **Image**: `Dockerfile.eso-refresher` (this repo) builds the `smooai-config-eso-refresher` process.
- **k8s wiring** (Deployment + RBAC + the refresher's own M2M Secret) lives in the smooai monorepo under SMOODEV-1525. RBAC must allow `patch` on the single bootstrap Secret only.
- **Root-of-trust**: the refresher's `SMOOAI_CONFIG_CLIENT_ID/SECRET` are provided as a one-time Kubernetes Secret (or IRSA-fronted). This is the only secret that does not flow through ESO — everything else syncs from it.

## Related

- Epic: SMOODEV-1522 (restore ESO secret sync).
- SMOODEV-1524 — schema-driven ESO manifest generator.
- SMOODEV-1525 — smooai: repoint ClusterSecretStore to `api.smoo.ai`, restore per-workload `ExternalSecret`s, drop the Pulumi-bake.
