---
'@smooai/config': patch
---

Put Kotlin and Swift on the shared release train, and add a fail-loud version guard.

`scripts/sync-versions.mjs` covered Python, Rust, .NET and Go but not Kotlin or
Swift, so those two silently stayed behind forever — Kotlin's `build.gradle.kts`
still read the default `0.1.0` while every other language rode 6.11.x, and Swift
had no version-bearing token at all. Kotlin is now synced, Swift gains a
`SmooAIConfigVersion.version` constant (mirroring `go/config/version.go`, since
SPM takes its version from the git tag and `Package.swift` has no field to sync).

The syncer gained a `--check` mode sharing the same target list, wired into
`check-all` and both CI workflows, so the checker cannot drift from the syncer.
It fails on version mismatch _and_ on a pattern that no longer matches its file —
the second is what let Kotlin rot, since a no-op sync is indistinguishable from
an already-synced one. `cargo publish` now runs `--locked`.
