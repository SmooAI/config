/// The released version of the SmooAIConfig Swift SDK.
///
/// SPM resolves a package version from its git tag, so `Package.swift` carries
/// no version field — this constant is the only version-bearing token in the
/// Swift SDK, and it is what `scripts/sync-versions.mjs` keeps on the release
/// train with the other six languages. Mirrors `go/config/version.go`.
public enum SmooAIConfigVersion {
    public static let version = "6.11.6"
}
