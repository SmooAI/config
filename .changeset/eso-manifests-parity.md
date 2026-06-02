---
'@smooai/config': minor
---

SMOODEV-1526: Port the ESO manifest generator (`buildClusterSecretStore` + `buildExternalSecret`) to the Go, Python, Rust, and C# SDKs for language parity with the TypeScript reference. Each emits the same ClusterSecretStore (webhook → real api.smoo.ai config-values endpoint) and per-workload ExternalSecret (secret-tier config keys → UPPER_SNAKE_CASE env vars, with overrides + duplicate guard), using each language's native snakecase util. Epic SMOODEV-1522.
