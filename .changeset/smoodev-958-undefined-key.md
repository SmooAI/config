---
'@smooai/config': patch
---

SMOODEV-958: Python/Rust/Go config managers now surface a friendly, actionable error when a caller asks for a config key that isn't declared in the schema — matching the TypeScript `assertKeyDefined` and .NET `ConfigKey` ctor behaviour added in SMOODEV-841. The most common cause is reading a `SecretConfigKeys.<X>` / `PublicConfigKeys.<X>` / `FeatureFlagKeys.<X>` constant for a key that isn't in `.smooai-config/config.ts`; previously the manager silently returned `None`/`nil`, masking the bug.

Opt in via `strict_schema_keys=True` / `WithStrictSchemaKeys(true)` / `with_strict_schema_keys(true)` — off by default to preserve back-compat (the existing `schema_keys` set has historically also served as an env-var filter). New `UndefinedKeyError` (Python), `*UndefinedKeyError` (Go), and `SmooaiConfigErrorKind::UndefinedKey` (Rust) types let callers programmatically catch and handle the case.
