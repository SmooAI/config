---
'@smooai/config': patch
---

SMOODEV-960: Add a "CLI is TS-only — install via Node" note to each per-language README (Python, Rust, Go, .NET). The `smooai-config` CLI (push / pull / list / set / diff / login) is TypeScript-only by design because the schema is authored in TS, but a Python/Rust/Go/.NET-only team installing the SDK had no docs hint that they still needed Node for the CLI. Pure docs change.
