---
'@smooai/config': major
---

**Breaking: unified `/server` + `/client` SDK (SMOODEV-611)**

The `/platform/runtime` and `/platform/server` entrypoints have been collapsed
into a single `@smooai/config/server` export with a unified priority chain.
`@smooai/config/client` has been expanded to mirror the same tier shape on
the browser side (without `secretConfig`).

### New backend surface — `@smooai/config/server`

```ts
import { buildConfig } from '@smooai/config/server';
import schema from '../../.smooai-config/config';

const config = buildConfig(schema);

// Async (idiomatic):
await config.secretConfig.get('sendgridApiKey');

// Sync (drop-in for constructors / top-level init, via synckit):
config.secretConfig.getSync('sendgridApiKey');
config.publicConfig.getSync('apiUrl');
config.featureFlag.getSync('observability');
```

Priority chain (public + secret):

1. **Baked blob** — AES-GCM `.enc` placed by the deploy-time baker.
2. **Env vars** — `process.env[UPPER_SNAKE_CASE_KEY]`. Per-key overrides.
3. **HTTP config API** — live fetch via `ConfigClient`.
4. **Local file** — defaults shipped under `.smooai-config/`.

Feature flags invert the top of the chain: HTTP first (live, 30s cache),
then env, then file. Blob is intentionally skipped so flags flip without
a redeploy.

### New frontend surface — `@smooai/config/client`

`buildClientConfig(schema)` exposes `publicConfig` + `featureFlag` (no
`secretConfig` — enforced at the type level). Reads bundle-baked env vars
first (`NEXT_PUBLIC_CONFIG_*` / `VITE_CONFIG_*`), falls through to HTTP.

### Migration

```diff
- import { buildConfigRuntime } from '@smooai/config/platform/runtime';
- const config = buildConfigRuntime(schema);
- await config.getSecretConfig('foo');

+ import { buildConfig } from '@smooai/config/server';
+ const config = buildConfig(schema);
+ await config.secretConfig.get('foo');
+ config.secretConfig.getSync('foo');
```

```diff
- import buildConfigObject from '@smooai/config/platform/server';
- const config = buildConfigObject(schema);
- await config.publicConfig.getAsync('foo');
- config.publicConfig.getSync('foo');

+ import { buildConfig } from '@smooai/config/server';
+ const config = buildConfig(schema);
+ await config.publicConfig.get('foo');
+ config.publicConfig.getSync('foo');
```

### Removed

- `@smooai/config/platform/runtime` — `buildConfigRuntime`, `readBakedConfig`, `hydrateConfigClient`
- `@smooai/config/platform/server` — `buildConfigObject`
- The internal `server.async` / `server.publicConfig.sync` / etc. worker files

Low-level building blocks stay:

- `@smooai/config/platform/client` — `ConfigClient` (HTTP-only class, used internally by `/server` and `/client`)
- `@smooai/config/platform/build` — `buildBundle` (deploy-time baker)

### Language parity

Python / Rust / Go SDKs remain on the pre-unification API for now. Parity
ports tracked as follow-up tickets — consumers of those SDKs are unaffected
by this release.
