---
'@smooai/config': minor
---

Add `@smooai/config/platform/runtime` and `@smooai/config/platform/build` — framework-agnostic bake-and-decrypt pattern for shipping config to deployment targets (Lambda, ECS, Fargate, EC2, containers, anywhere Node + filesystem).

**Pattern** (mirrors SST v4's `Resource.*` cold-start-decrypt, without the SST coupling):

1. Deploy-time baker (`buildBundle`) calls `ConfigClient.getAllValues(env)`, partitions via `classifyFromSchema` (public + secret into the blob, feature flags skipped), encrypts with AES-256-GCM, returns `{ keyB64, bundle }`. Deploy glue writes the bundle to disk and sets `SMOO_CONFIG_KEY_FILE` + `SMOO_CONFIG_KEY` on the function.
2. Runtime helper (`buildConfigRuntime(schema)`) decrypts the blob once at cold start and exposes the same typed `getPublicConfig` / `getSecretConfig` / `getFeatureFlag` API as the existing `buildConfigObject` — consumer code stays identical.
3. Feature flags always hit the config API at runtime (they're designed to flip without a redeploy), routed through a cached `ConfigClient`.

Blob layout: `nonce (12 random bytes) || ciphertext || authTag (16 bytes)`. Random nonce + fresh key per `buildBundle` — no key-reuse hazard across re-bakes.

Paired with a deploy-pipeline adapter in your infra repo (SST, Pulumi, Vercel, whatever), this eliminates the 4 KB Lambda env-var ceiling for secrets while keeping the library API unchanged.
