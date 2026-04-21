---
'@smooai/config': patch
---

**Docs: generalise the `.getSync()` sidecar guidance to any bundled compute**

The README previously framed the sync-worker sidecar pattern as a "Lambda via SST" optimisation. The sidecar is the right approach for _any_ bundled compute runtime — Lambda, Cloud Run, ECS, containers, Serverless Framework, SAM, plain esbuild/tsup outputs.

Expanded the "How `.getSync()` works" section with:

- A clearer explanation that the sidecar vs. `/tmp` fallback is about bundling, not about which cloud you run on.
- Concrete recipes for esbuild, tsup, Serverless Framework, SST, Docker containers, and plain Node (already works with no config).
- An explicit "you can ignore this" callout — path (2) is a working safety net, the sidecar just saves one `/tmp` write per cold start.
- Edge runtime note stays as-is — `.getSync()` needs `worker_threads`, which edge runtimes don't expose, so the answer there is always `.get()` async.

No code changes.
