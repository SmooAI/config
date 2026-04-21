---
'@smooai/config': patch
---

**SMOODEV-646: `smooConfigPlugin` — inject `process.env.VITE_*` as well as `import.meta.env.VITE_*`**

`getClientPublicConfig` / `getClientFeatureFlag` read `process.env.VITE_*` by design (so the same SDK code path works on Next.js + Vite). The Vite plugin previously only substituted `import.meta.env.VITE_*`, so at browser runtime the SDK getters returned `undefined` — no bundle-baked values.

Fix: the plugin now emits **both** `import.meta.env.VITE_X` and `process.env.VITE_X` define entries. Bundled values finally make it through to `getClientPublicConfig('apiUrl')` / `getClientFeatureFlag('observability')` in Vite apps.
