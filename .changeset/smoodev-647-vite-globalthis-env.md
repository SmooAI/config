---
'@smooai/config': patch
---

**SMOODEV-647: `smooConfigPlugin` populates `globalThis.__VITE_ENV__` for dynamic SDK getters**

`getClientPublicConfig(key)` / `getClientFeatureFlag(key)` use DYNAMIC property access (`process.env[\`VITE*CONFIG*\${envKey}\`]`) which Vite's `define`can't substitute per-key. The SDK's getters already had a fallback path checking`globalThis.**VITE_ENV**` at runtime — the plugin just never populated it.

The plugin now emits `define: { 'globalThis.__VITE_ENV__': JSON.stringify(envVars) }` in addition to the per-key static substitutions. Bundle-baked values now flow through the SDK's dynamic getters in Vite apps.
