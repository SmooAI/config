---
'@smooai/config': patch
---

Bootstrap token exchange now retries transient 429/5xx responses with exponential backoff + jitter (5 attempts), so CI image builds survive AuthIssuer throttling (ReservedFunctionConcurrentInvocationLimitExceeded). Permanent 4xx (e.g. 401 invalid_client) still fail fast.
