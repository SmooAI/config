---
'@smooai/config': minor
---

Use Zod v4's built-in `z.toJSONSchema()` instead of the `zod-to-json-schema` adapter. Drops the adapter dep (typed against Zod v3 — needed `as any` casts to pass Zod v4 schemas through) and removes the related stubs from the browser-build alias map. Runtime output shape is equivalent. Also drops the `zod-to-json-schema` runtime dependency.
