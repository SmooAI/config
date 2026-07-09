// SmooAIConfig — the mobile runtime mode of @smooai/config for Kotlin/Android
// (ADR-074, SMOODEV-2381). Pure-Kotlin JVM library (no Android SDK) with a
// caller-injected Ktor engine, mirroring the consuming app's :core module.
// Versions match apps/mobile/android/core (Kotlin 2.1.20, Ktor 3.2.3).
plugins {
    kotlin("jvm") version "2.1.20"
    kotlin("plugin.serialization") version "2.1.20"
    `maven-publish`
    signing
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

java {
    // Central requires -sources and -javadoc jars.
    withSourcesJar()
    withJavadocJar()
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

// JitPack runs `gradle publishToMavenLocal` (see /jitpack.yml). Maven Central
// (SMOODEV-2386) runs `gradle publish -Pversion=<x.y.z>` from release.yml with
// OSSRH_USERNAME/OSSRH_PASSWORD (Sonatype central portal token) + the signing
// env vars below; all publishing metadata Central requires lives on the POM.
publishing {
    publications {
        create<MavenPublication>("maven") {
            from(components["java"])
            artifactId = "smooai-config"
            pom {
                name.set("SmooAIConfig")
                description.set("Mobile runtime mode of @smooai/config — baked public config + live feature flags/limits for Kotlin/Android.")
                url.set("https://github.com/SmooAI/config")
                licenses {
                    license {
                        name.set("MIT")
                        url.set("https://github.com/SmooAI/config/blob/main/LICENSE")
                    }
                }
                developers {
                    developer {
                        id.set("smooai")
                        name.set("Smoo AI")
                        url.set("https://smoo.ai")
                    }
                }
                scm {
                    url.set("https://github.com/SmooAI/config")
                    connection.set("scm:git:https://github.com/SmooAI/config.git")
                }
            }
        }
    }
    repositories {
        maven {
            name = "central"
            url = uri("https://ossrh-staging-api.central.sonatype.com/service/local/staging/deploy/maven2/")
            credentials {
                username = System.getenv("OSSRH_USERNAME")
                password = System.getenv("OSSRH_PASSWORD")
            }
        }
    }
}

// Signing is REQUIRED by Central but must not break local dev / JitPack:
// only sign when the key is present (CI publish path).
signing {
    val signingKey = System.getenv("MAVEN_SIGNING_KEY")
    val signingPassword = System.getenv("MAVEN_SIGNING_PASSWORD")
    if (!signingKey.isNullOrBlank()) {
        useInMemoryPgpKeys(signingKey, signingPassword)
        sign(publishing.publications["maven"])
    }
}
