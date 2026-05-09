---
'@smooai/config': patch
---

Add priority-chain integration tests across Python, Go, Rust, and .NET so each language has parity coverage with TypeScript's `server.priority-chain.integration.test.ts`. Test-only — no source changes.

Documentation: per-SDK READMEs now cover the baked-runtime path (`SMOO_CONFIG_KEY_FILE` / `SMOO_CONFIG_KEY` env-var contract), have a Common errors section calling out the SMOODEV-847 schema-not-declared case, and the top-level README has a new Languages / SDKs section linking to each SDK's README. Added `dotnet/README.md` as the repo-level .NET entry point.
