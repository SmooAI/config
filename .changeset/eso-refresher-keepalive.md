---
'@smooai/config': patch
---

SMOODEV-1527: Fix the eso-refresher exiting immediately after its initial mint (it `unref()`'d the interval timer, and a pending `await new Promise(() => {})` doesn't hold Node's event loop open — so the process exited 0 → CrashLoopBackOff). The production interval now keeps the daemon alive; tests inject their own scheduler so they're unaffected.
