---
'@smooai/config': patch
---

**SMOODEV-642: `getSource()` now reflects sync reads**

`cfg.getSource(key)` used to return `undefined` for any key that had only been read via `.getSync()`. Each synckit worker has its own module scope, so the worker's `lastSource` map never propagated back to the parent thread.

Fix: the synckit worker now returns a `{ value, source }` envelope. The parent-thread wrapper in `/server/index.ts` calls a new internal `recordSource(key, source)` helper to copy the source into its own `lastSource` map. `getSource` works identically for sync + async reads now.
