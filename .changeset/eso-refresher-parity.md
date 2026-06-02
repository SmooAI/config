---
'@smooai/config': minor
---

SMOODEV-1526: Port the ESO bearer-token refresher core (the refresh algorithm + `SecretWriter` abstraction) to the Go, Python, Rust, and C# SDKs for parity with the TypeScript reference. Each mirrors the same behavior — invalidate-then-mint each cycle so the bootstrap Secret always holds a near-full-TTL token, fail-loud initial write, non-fatal loop-tick retries — driven by the language's own TokenProvider and unit-tested with a fake writer (no live cluster). The k8s-backed writer is intentionally an optional adapter so base SDK consumers don't pull a heavy k8s client; the TypeScript sidecar remains the canonical deployable. Epic SMOODEV-1522.
