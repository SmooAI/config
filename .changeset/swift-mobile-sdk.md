---
'@smooai/config': minor
---

SMOODEV-2380 (ADR-073): Swift SDK (`/swift`, SPM package `SmooAIConfig`) — the first mobile runtime mode implementation. Baked public-config bundle + live user-JWT flag/limit evaluation against the `/config/app/*` surface, offline-safe read chains, zero dependencies. Parity contract: `docs/Mobile-Runtime-Mode-Spec.md`.
