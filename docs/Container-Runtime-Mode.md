# `@smooai/config` — Container / Runtime Mode

**Epic:** SMOODEV-1489 · **Reference impl:** SMOODEV-1490 (TypeScript)

This is the single canonical, language-agnostic guide for running `@smooai/config`
in a long-lived **container** (EKS/ECS). The TS/dotnet/go/python/rust SDKs all
implement the same behavior and the same environment contract — idioms differ,
behavior does not. The authoritative contract is
[`Container-Runtime-Mode-Spec.md`](Container-Runtime-Mode-Spec.md); this doc is
the operator/runbook companion.

---

## Why not the baked blob in a container?

`@smooai/config` resolves values through four tiers: **blob → env → http → file**.

The **blob** tier — an encrypted config bundle baked into a Lambda layer / image at
deploy time and decrypted with a key delivered separately — is the blessed path for
**Lambda**. It is the _wrong_ default for a long-lived container:

- The per-build blob key has to be delivered to the running pod. When it isn't,
  resolution silently falls through to the (absent) file tier and returns
  **`undefined`** for a required secret.
- A real incident (**SMOODEV-1478**): a container got `undefined` for
  `STRIPE_API_KEY`. A module-load `new Stripe(undefined)` threw, the process
  exited `0` before `listen()`, and the service **CrashLooped** — with the root
  cause buried under unrelated log noise.

**Container mode** makes the **HTTP tier the first-class path** for containers,
authenticated with an OAuth2 `client_credentials` (M2M) token, and **fail-loud**:
a missing required value is an immediate, typed error (never a silent `undefined`),
and a `configHealth()` status is exposed for Kubernetes probes.

> **Rule of thumb: containers use container mode, not the baked blob.**

---

## 1. Environment contract

Set on the pod. These names are identical in every SDK.

| Env var                       | Required | Meaning                                                                  |
| ----------------------------- | -------- | ------------------------------------------------------------------------ |
| `SMOOAI_CONFIG_MODE`          | no       | `container` selects this mode explicitly (also auto-selected — see §2).  |
| `SMOOAI_CONFIG_API_URL`       | **yes**  | Config API base URL (e.g. `https://api.smoo.ai`).                        |
| `SMOOAI_CONFIG_AUTH_URL`      | no       | OAuth issuer base URL. Default `https://auth.smoo.ai`.                   |
| `SMOOAI_CONFIG_CLIENT_ID`     | **yes**  | M2M OAuth client id.                                                     |
| `SMOOAI_CONFIG_CLIENT_SECRET` | **yes**  | M2M OAuth client secret (legacy alias `SMOOAI_CONFIG_API_KEY` accepted). |
| `SMOOAI_CONFIG_ORG_ID`        | **yes**  | Organization id whose config to fetch.                                   |
| `SMOOAI_CONFIG_ENV`           | **yes**  | Environment name (e.g. `production`).                                    |

`initContainerConfig()` validates all of the required vars at startup. If any are
missing or blank it throws `ConfigBootstrapError` listing **exactly** which vars are
missing — no partial init.

`SMOOAI_CONFIG_CLIENT_ID` / `SMOOAI_CONFIG_CLIENT_SECRET` are **secrets** — source
them from your cluster's secret store (AWS Secrets Manager via the External Secrets
Operator, below). The rest are non-secret and belong in a `ConfigMap` / plain
`Deployment` env.

---

## 2. Mode selection

At init, the SDK picks a mode in this order:

1. `SMOOAI_CONFIG_MODE=container` → **container mode** (HTTP-primary, fail-loud).
2. else if a blob/file source is present → existing behavior (Lambda/local), unchanged.
3. else if `SMOOAI_CONFIG_CLIENT_ID` + `SMOOAI_CONFIG_CLIENT_SECRET` + `SMOOAI_CONFIG_API_URL`
   are all set → **container mode** (auto; logs once).
4. else → existing default behavior.

Container mode **never** silently degrades to the file tier. If it's selected and the
HTTP tier can't be constructed (missing required env), it fails at bootstrap.

In container mode the resolution chain is **env → http** only. An explicitly-set
process env var still wins (matching the existing tier precedence), so per-key
overrides work for break-glass; everything else comes from the config server.

---

## 3. Fail-loud semantics

- **Bootstrap** — `initContainerConfig()` validates the §1 env and performs an
  initial token mint + config fetch, so auth/network failures surface at **startup**,
  not on first read. Missing env → `ConfigBootstrapError { missing: string[] }`.
- **Required-key reads** — `secretConfig.get` / `getSync` (and the public/flag
  analogs) for a **required** key that resolves absent across the active tiers
  throw `ConfigKeyUnresolvedError { key, env, triedTiers }`. They **never** return
  `undefined`/null/empty for a required key.
- **Optional keys** — pass `initContainerConfig({ optionalKeys: ['someKey'] })`; reads
  of those return the language's absent value instead of throwing.
- **Default-required posture** — every key declared in your schema is treated as
  required unless listed in `optionalKeys`. (Design decision for the TS reference;
  mirrored by all SDKs. See the design note in the package README.)

This directly closes the SMOODEV-1478 / SMOODEV-1135 silent-`undefined` class.

---

## 4. Caching & refresh

- **Token** — cached and proactively refreshed before expiry (default 60s buffer).
  On a `401` the SDK invalidates the token and retries once.
- **Config values** — cached with a TTL (**default 30s** in every SDK). A background
  refresh failure does **not** flip a previously-healthy value to unresolved: the SDK
  logs and serves the **last-good** value until the TTL hard-expires, at which point
  `configHealth()` reports `Unhealthy`.

---

## 5. Health check (readiness / liveness)

`configHealth()` (and `handle.health()`) returns a non-throwing status:

```ts
{ status: 'healthy' }
{ status: 'unhealthy', reason: string }
```

It is `Healthy` once the initial fetch has succeeded and stays `Healthy` while serving
last-good within the cache TTL; it flips `Unhealthy` when the initial fetch never
succeeded, or a refresh has been failing past the TTL hard-expiry.

Wire it to a `/healthz/config` endpoint (TypeScript example):

```ts
import { initContainerConfig } from '@smooai/config/container';
import schema from '../.smooai-config/config';

const config = await initContainerConfig({ schema });

app.get('/healthz/config', (_req, res) => {
    const h = config.health();
    res.status(h.status === 'healthy' ? 200 : 503).json(h);
});
```

---

## 6. Kubernetes recipe

### 6.1 ExternalSecret — pull the M2M creds from AWS Secrets Manager

Using the [External Secrets Operator](https://external-secrets.io/). Assumes a
`SecretStore`/`ClusterSecretStore` named `aws-secrets-manager` already wired to your
account, and a Secrets Manager secret `smooai/config/m2m` with JSON keys
`client_id` and `client_secret`.

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
    name: smooai-config-m2m
    namespace: my-service
spec:
    refreshInterval: 1h
    secretStoreRef:
        name: aws-secrets-manager
        kind: ClusterSecretStore
    target:
        name: smooai-config-m2m # the k8s Secret this creates
        creationPolicy: Owner
    data:
        - secretKey: SMOOAI_CONFIG_CLIENT_ID
          remoteRef:
              key: smooai/config/m2m
              property: client_id
        - secretKey: SMOOAI_CONFIG_CLIENT_SECRET
          remoteRef:
              key: smooai/config/m2m
              property: client_secret
```

### 6.2 Deployment — non-secret env + secret env + readiness probe

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
    name: my-service
    namespace: my-service
spec:
    replicas: 2
    selector:
        matchLabels: { app: my-service }
    template:
        metadata:
            labels: { app: my-service }
        spec:
            containers:
                - name: my-service
                  image: ghcr.io/smooai/my-service:latest
                  ports:
                      - containerPort: 8080
                  env:
                      # --- Non-secret container-mode config (plain env) ---
                      - name: SMOOAI_CONFIG_MODE
                        value: container
                      - name: SMOOAI_CONFIG_API_URL
                        value: https://api.smoo.ai
                      - name: SMOOAI_CONFIG_AUTH_URL
                        value: https://auth.smoo.ai
                      - name: SMOOAI_CONFIG_ORG_ID
                        value: '00000000-0000-0000-0000-000000000000' # your org id
                      - name: SMOOAI_CONFIG_ENV
                        value: production
                      # --- Secret container-mode config (from the ExternalSecret) ---
                      - name: SMOOAI_CONFIG_CLIENT_ID
                        valueFrom:
                            secretKeyRef:
                                name: smooai-config-m2m
                                key: SMOOAI_CONFIG_CLIENT_ID
                      - name: SMOOAI_CONFIG_CLIENT_SECRET
                        valueFrom:
                            secretKeyRef:
                                name: smooai-config-m2m
                                key: SMOOAI_CONFIG_CLIENT_SECRET
                  # --- Readiness probe wired to configHealth() ---
                  readinessProbe:
                      httpGet:
                          path: /healthz/config
                          port: 8080
                      initialDelaySeconds: 3
                      periodSeconds: 10
                      failureThreshold: 3
```

The non-secret vars can also live in a `ConfigMap` and be pulled in with `envFrom`;
the secret vars must come from the `secretKeyRef` (or `envFrom` a `secretRef`) so the
M2M credentials never sit in plaintext manifests.

---

## 7. Per-language entry points

| SDK        | Init                              | Health            |
| ---------- | --------------------------------- | ----------------- |
| TypeScript | `initContainerConfig({ schema })` | `config.health()` |
| .NET       | `InitContainerConfig(...)`        | `ConfigHealth()`  |
| Go         | `InitContainerConfig(ctx, ...)`   | `handle.Health()` / `ConfigHealthOf(handle)` |
| Python     | `init_container_config(...)`      | `config_health()` |
| Rust       | `init_container_config(...)`      | `config_health()` |

Each SDK's README links back to this doc and shows the language's
`initContainerConfig` + health snippet.

---

## Related

- [`Container-Runtime-Mode-Spec.md`](Container-Runtime-Mode-Spec.md) — the authoritative parity contract.
- SMOODEV-1478 — the silent-`undefined` CrashLoop incident this mode prevents.
- SMOODEV-1495 — the voice/EKS wiring that consumes this (follow-up).
