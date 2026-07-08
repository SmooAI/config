---
'@smooai/config': patch
---

SMOODEV-2389: Mobile SDK parity fixes (ADR-074 / Mobile-Runtime-Mode-Spec). Swift: `publicValue(forKey:)` is now truly synchronous (spec row 2) — `SmooConfig` is a lock-guarded class instead of an actor, the structural twin of the Kotlin SDK. Both SDKs: `evaluateLimit` gains `step` (snaps to the nearest multiple before the `[min, max]` clamp, matching TS `clampLimit` / Rust `clamp_limit` per ADR-066), and evaluate failures now throw typed errors carrying the key (`featureFlagNotFound`/`featureFlagContext`/`featureFlagEvaluation` + `limit*` siblings in Swift; `FeatureFlagNotFoundException` et al. in Kotlin) so callers can branch on 404/400/5xx without parsing messages. Kotlin: `SmooConfig` is now `Closeable` (releases the Ktor client).
