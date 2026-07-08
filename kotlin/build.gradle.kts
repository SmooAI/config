// SmooAIConfig — the mobile runtime mode of @smooai/config for Kotlin/Android
// (ADR-074, SMOODEV-2381). Pure-Kotlin JVM library (no Android SDK) with a
// caller-injected Ktor engine, mirroring the consuming app's :core module.
// Versions match apps/mobile/android/core (Kotlin 2.1.20, Ktor 3.2.3).
plugins {
    kotlin("jvm") version "2.1.20"
    kotlin("plugin.serialization") version "2.1.20"
    `maven-publish`
}

group = "ai.smoo"
// JitPack passes -Pversion=<tag/sha> (see /jitpack.yml); default for local dev.
version = (findProperty("version") as String?)?.takeIf { it != "unspecified" } ?: "0.1.0"

repositories {
    mavenCentral()
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    api("io.ktor:ktor-client-core:3.2.3")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")

    testImplementation(kotlin("test"))
    testImplementation("io.ktor:ktor-client-mock:3.2.3")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
}

tasks.test {
    useJUnitPlatform()
}

// JitPack runs `gradle publishToMavenLocal` (see /jitpack.yml).
publishing {
    publications {
        create<MavenPublication>("maven") {
            from(components["java"])
        }
    }
}
