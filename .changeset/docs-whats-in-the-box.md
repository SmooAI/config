---
'@smooai/config': patch
---

**Docs: reframe TypeScript README as a capability showcase + link synckit**

- Replaced the "What's New in v3" section with a "What's in the box" showcase that lists what each subpath does — no version-narrative framing, since the SDK is still in its early rollout.
- Added an outbound link to [`un-ts/synckit`](https://github.com/un-ts/synckit) in the `.getSync()` architecture section so readers can find the actual library we use for sync-over-async via `worker_threads` + `Atomics.wait` + `SharedArrayBuffer`.

Docs-only. No behavioural change.
