// swift-tools-version: 5.9
// Root SPM manifest (SMOODEV-2382): Swift Package Manager can only resolve a
// package at the repository root, so this manifest exposes the mobile SDK
// that lives under /swift. Consumers depend on this repo's git URL pinned to
// a revision (the cargo-git-dep house pattern):
//
//   .package(url: "https://github.com/SmooAI/config", revision: "<sha>")
//
// Keep in lock-step with swift/Package.swift (the standalone dev manifest).
import PackageDescription

let package = Package(
    name: "SmooAIConfig",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "SmooAIConfig", targets: ["SmooAIConfig"])
    ],
    targets: [
        .target(name: "SmooAIConfig", path: "swift/Sources/SmooAIConfig"),
        .testTarget(name: "SmooAIConfigTests", dependencies: ["SmooAIConfig"], path: "swift/Tests/SmooAIConfigTests"),
    ]
)
