---
'@smooai/config': patch
---

SMOODEV-666: Multi-target the SmooAI.Config NuGet package to `net8.0;net9.0;net10.0` so consumers on every current .NET LTS + STS release get a native framework match. The Roslyn source generator stays at `netstandard2.0` (required by the Roslyn host).
