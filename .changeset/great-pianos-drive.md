---
'@smooai/config': patch
---

Bring the .NET SDK to parity with the other four server SDKs.

.NET was missing five things TS/Python/Rust/Go all have: `LocalConfigManager`,
cloud-region resolution, deferred values, `MergeReplaceArrays`, and — the one
that mattered most — it did not consume the shared
`test-fixtures/schema-validation-cases.json` corpus. All five now land, with
`SchemaValidator` held to the same 24 cases as the other four, so the "shared"
fixture is finally shared by 5 of 5 server SDKs instead of 4.

Also fixes a latent flake in the existing suite: `LocalConfigManagerTests` and
`ResolveAsyncFallbackTests` both drive the process-global
`SMOOAI_CONFIG_FILE_DIR` and `EnvFileFallback`'s static file cache, so the new
class joins the existing `EnvSerial` xunit collection rather than racing it.
