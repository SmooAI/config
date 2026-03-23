---
'@smooai/config': major
---

BREAKING: Split browser/server exports for `@smooai/config`. The `./config` entrypoint no longer re-exports `findAndProcessFileConfig` or `findAndProcessEnvConfig` — server-only consumers must import from `@smooai/config/config/server` instead. Added `dist/browser/` build with esbuild alias stubs so browser bundles never pull in Node.js-only dependencies (Logger, esm-utils, schema serializers, etc.). Added `"browser"` conditional exports for all browser-safe paths.
