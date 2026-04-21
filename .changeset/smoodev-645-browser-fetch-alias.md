---
'@smooai/config': patch
---

**SMOODEV-645: fix browser bundle pulling Node-only deps via `@smooai/fetch`**

`@smooai/config/client` (and `/react`) broke Vite / Next.js consumer builds with `Module 'node:v8' has been externalized`. Root cause: `platform/client.ts` does `import fetch from '@smooai/fetch'`, but `@smooai/fetch`'s package.json exposes its browser entry only as the `./browser/*` subpath — it has no top-level `browser` condition. In the tsup browser build, the bare specifier resolved to the Node entry, dragging in `@smooai/logger` + `rotating-file-stream` + `import-meta-resolve`.

Fix: in the browser tsup build, add `@smooai/fetch` to `noExternal` and alias the bare specifier to `@smooai/fetch/browser/index` via esbuild's native `alias`. Browser chunks now inline the browser-safe fetch implementation.

Verified:

```
grep -l "rotating-file-stream\|@smooai/logger" dist/browser/chunk-*.mjs
# (no matches)

grep "@smooai/fetch/dist/browser" dist/browser/chunk-*.mjs
# chunk-...: // node_modules/.../@smooai/fetch/dist/browser/index.mjs
```

Frontend consumers no longer need to manually alias `@smooai/fetch`.
