---
'@smooai/config': patch
---

**Fix Vite/webpack consumer builds pulling `rotating-file-stream` via stale `@smooai/fetch`**

The previous release (4.2.0) dropped `@smooai/fetch` from `tsup`'s browser `noExternal`, relying on `@smooai/fetch@3.1.0`'s new top-level `browser` export condition to do the right thing on consumer side. That's brittle: if a consumer's dep tree resolves `@smooai/fetch` to `2.x` elsewhere (smooai monorepo currently does), `platform: 'browser'` falls back to the Node entry, which pulls `@smooai/logger` + `rotating-file-stream`, breaking the build with:

```
"access" is not exported by "__vite-browser-external", imported by "rotating-file-stream/dist/esm/index.js"
```

This patch:

1. Re-adds `@smooai/fetch` to the browser build's `noExternal` list, so fetch is bundled into `dist/browser/` and consumers never need to resolve it themselves. Adds a few KB to the browser dist for robustness — not dependent on consumer-side resolution.

2. Bumps the declared `@smooai/fetch` dep from `^2.1.0` to `^3.1.0` so the inlined version benefits from the browser condition.

No API changes. 4.1.x consumers upgrading to 4.2.1 get a clean browser build with zero Node-only transitive pulls.
