// swift-tools-version: 5.9
// SmooAIConfig — the mobile runtime mode of @smooai/config (ADR-074, SMOODEV-2380).
// Zero external dependencies by design (Foundation only), mirroring the
// SDK-free ethos of the consuming apps' core packages.
import PackageDescription

let package = Package(
    name: "SmooAIConfig",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "SmooAIConfig", targets: ["SmooAIConfig"])
    ],
    targets: [
        .target(name: "SmooAIConfig", path: "Sources/SmooAIConfig"),
        .testTarget(name: "SmooAIConfigTests", dependencies: ["SmooAIConfig"], path: "Tests/SmooAIConfigTests"),
    ]
)
