---
'@smooai/config': patch
---

SMOODEV-928: Bump `@smooai/logger` to `^4.1.4`, `@smooai/utils` to `^1.3.3`, and `@smooai/fetch` to `^3.3.5`. Picks up the ESM `__filename` TDZ fix from logger 4.1.4 across the runtime dep graph (utils 1.3.2 and fetch 3.3.4 both still pulled logger 3.x as their own runtime deps).
