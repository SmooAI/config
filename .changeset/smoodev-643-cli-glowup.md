---
'@smooai/config': minor
---

SMOODEV-643: CLI glowup — `smooai-config` now authenticates via OAuth2 client-credentials (auto-refreshing access tokens), loads TypeScript configs through `jiti` so explicit `ReturnType<typeof defineConfig>` annotations no longer crash `push`, requires an explicit `--schema-name` (or `schemaName` export / `$smooaiName` field) to prevent accidental schema creation from `cwd` basename, surfaces server-side `{ success: false }` envelopes as real errors instead of silent empty lists, and ships a refreshed Ink UI with Smoo AI brand colors, a larger `Smoo AI` banner, boxed summary/success/error panels, secret redaction on `set`/`list`, and actionable `Try: …` hints on failures. Legacy `--api-key` continues to work.
