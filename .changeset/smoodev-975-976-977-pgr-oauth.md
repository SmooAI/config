---
'@smooai/config': major
---

SMOODEV-975/976/977: Python, Go, and Rust ConfigClients now exchange OAuth client_credentials for a JWT (parity with TS / .NET, fixing the silent 401s that previously sent the raw API key as Bearer). Each runtime SDK now requires `client_id` in addition to `client_secret`/`api_key`. New `TokenProvider` class exported in each language for caching/refresh (60s default refresh window, single-flight under a lock, invalidate-and-retry once on 401). Breaking change in constructors of all three SDKs.
