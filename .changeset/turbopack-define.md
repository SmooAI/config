---
'@smooai/config': minor
---

withSmooConfig: also wire `__SMOO_CLIENT_ENV__` through `nextConfig.compiler.define`

`compiler.define` is Next.js 16's native compile-time replacement — it works for
both webpack and turbopack out of the box with the same code-fragment semantics
as webpack's DefinePlugin. Adding it alongside the existing DefinePlugin call
means consumers no longer need `next dev --webpack` (or `next build --webpack`)
to make `getClientPublicConfig(...)` / `getClientFeatureFlag(...)` resolve.

Webpack DefinePlugin path is preserved as defense-in-depth so older Next.js
versions and webpack-only pipelines keep working.
