---
'@smooai/config': minor
---

**SMOODEV-617: fix `.getSync()` for bundled consumers (Lambda, Vercel, Next.js)**

`buildConfig(schema).<tier>.getSync(key)` used to hang indefinitely when the SDK was bundled by esbuild — in AWS Lambda bundles, Vercel edge, or any tsup/rollup consumer. Root cause: `createSyncFn(path)` needs a physical `.js` worker file on disk, but the consumer's bundler tree-shook it out.

Fix: the SDK now bundles the synckit worker into a **string constant** at SDK build time (via `scripts/build-sync-worker.mjs`), and at first-use writes that string to `mkdtempSync()/sync-worker.mjs` before handing the `file://` URL to `createSyncFn`. Zero consumer configuration required — works out of the box inside Lambdas, Vercel fns, Fargate tasks, CLI scripts.

### What changed

- New build step: `pnpm build:sync-worker` runs before `pnpm tsup`, emitting `src/server/sync-worker-source.generated.ts` with the full ESM worker source (every dep inlined except Node builtins, CJS `require` polyfilled via `createRequire(import.meta.url)`).
- `src/server/index.ts` imports `WORKER_SOURCE` and materializes it to `/tmp` once per process.
- Smoke tests confirm `.getSync()` returns in ~50ms incl. worker spawn, matches `.get()` (async) output exactly.

### No API change

Consumers do not need to touch their code. Existing `buildConfig(schema).secretConfig.getSync('foo')` calls just work once `@smooai/config` is bumped.
