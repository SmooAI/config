---
'@smooai/config': patch
---

SMOODEV-657: Add SmooAI.Config .NET (C#) client — phase 1

New `dotnet/` folder with a `SmooAI.Config` NuGet package (net8.0) providing the
HTTP client surface + OAuth2 client-credentials exchange that matches the TS,
Rust, and Go clients. Published to nuget.org via the `publish-nuget.yml`
workflow triggered by `dotnet-v*` tags. Cohort-aware evaluator and
`buildBundle` / `buildConfigRuntime` helpers will land in a follow-up phase.
