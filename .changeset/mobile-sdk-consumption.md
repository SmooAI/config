---
'@smooai/config': patch
---

SMOODEV-2382 (ADR-074): mobile SDK consumption enablers — root `Package.swift` (SPM resolves only at repo root; consumers pin a revision) and `jitpack.yml` + maven-publish for the Kotlin SDK (`com.github.SmooAI:config:<sha>` via JitPack; Maven Central under `ai.smoo` is the durable follow-up). Also sweeps doc/code references ADR-073 → ADR-074 (073 was claimed by a parallel workstream).
