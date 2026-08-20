# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Use Context7 MCP server for up-to-date library documentation.**

## Project Overview

@smooai/config is a multi-language, type-safe configuration management library. It enables defining configuration schemas once and validating them everywhere with three-tier configuration (public config, secrets, feature flags), StandardSchema support (Zod, Valibot, ArkType, Effect Schema), and runtime clients for fetching centralized config from a config server. Includes a CLI tool and framework integrations for Next.js, React, and Vite.

> **CRITICAL: All feature work MUST happen in a git worktree.** Never edit source code or commit directly on `main` in `~/dev/smooai/config/`. The main worktree stays on `main` and is only used for merging, pulling, and creating new worktrees. A `PreToolUse` hook enforces this — see `.claude/hooks/enforce-worktree.sh`.

---

## Git Workflow — Worktrees (MANDATORY for all feature work)

### Working directory structure

```
~/dev/smooai/
├── config/                              # Main worktree (ALWAYS on main)
├── config-SMOODEV-XX-short-desc/        # Feature worktree
└── ...
```

### Branch naming

Always prefix with the Jira ticket number:

```
SMOODEV-XX-short-description
```

### Commit messages

Always prefix with the Jira ticket:

```
SMOODEV-XX: Descriptive message explaining why
```

### Creating a worktree

```bash
cd ~/dev/smooai/config
git worktree add ../config-SMOODEV-XX-short-desc -b SMOODEV-XX-short-desc main
cd ../config-SMOODEV-XX-short-desc
pnpm install
cd python && uv sync && cd ..
```

### Merging to main

```bash
cd ~/dev/smooai/config
git checkout main && git pull --rebase
git merge SMOODEV-XX-short-desc --no-ff
git push
```

### Cleanup after merge

```bash
git worktree remove ~/dev/smooai/config-SMOODEV-XX-short-desc
git branch -d SMOODEV-XX-short-desc
```

---

## Build, Test, and Development Commands

### All languages

```bash
pnpm install              # Install TypeScript dependencies
pnpm build                # Build all 7 languages
pnpm test                 # Run all 7 languages' tests
pnpm lint                 # Lint all languages
pnpm format               # Format all 7 languages
pnpm format:check         # Check formatting, all 7 languages
pnpm typecheck            # Type check all languages
pnpm version:check        # Assert all 7 language manifests match package.json
pnpm check-all            # Full CI parity (versions, typecheck, lint, format, test, build)
```

`build`, `test`, `format` and `format:check` fan out to **all seven** SDKs.
.NET, Kotlin and Swift go through `scripts/with-toolchain.mjs`, which:

- **skips** with an explicit `⏭ skipped: no <bin> on PATH` line when you don't
  have that toolchain locally, so `check-all` still runs; but
- **fails hard under `CI`** on any missing toolchain, unless the workflow named
  it in `SMOOAI_SKIP_TOOLCHAINS`.

That second rule is the point: a silent skip is indistinguishable from a pass,
which is how .NET, Kotlin and Swift sat outside "full CI parity" while
`check-all` reported success. A CI job that cannot run a language must _declare_
it, and another job has to own it (Swift on the macOS runner, Kotlin on the JDK
job).

### TypeScript

```bash
pnpm build:lib            # Build TypeScript library
pnpm test                 # Vitest
pnpm typecheck            # tsc
pnpm lint                 # oxlint
pnpm format               # oxfmt
```

### Python

```bash
cd python && uv sync --group dev   # Setup Python environment
poe build                          # Build wheel + sdist
poe test                           # pytest
poe lint                           # Ruff check
poe format                         # Ruff format
poe typecheck                      # BasedPyright

# Or from root:
pnpm python:build
pnpm python:test
pnpm python:lint
pnpm python:format
pnpm python:typecheck
```

### Rust

```bash
cd rust/config
cargo build --release
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt

# Or from root:
pnpm rust:build
pnpm rust:test
pnpm rust:lint
```

### Go

```bash
cd go/config
go build ./...
go test -v ./...
go vet ./...
gofmt -w .

# Or from root:
pnpm go:build
pnpm go:test
pnpm go:lint
```

### .NET

```bash
cd dotnet
dotnet build -c Release
dotnet test -c Release
dotnet format                     # dotnet format --verify-no-changes to check

# Or from root:
pnpm dotnet:build
pnpm dotnet:test
pnpm dotnet:format
pnpm dotnet:format:check
```

### Kotlin

```bash
cd kotlin
./gradlew assemble
./gradlew test
./gradlew ktlintFormat            # ktlintCheck to verify

# Or from root:
pnpm kotlin:build
pnpm kotlin:test
pnpm kotlin:format
pnpm kotlin:format:check
```

ktlint reads `kotlin/.editorconfig` (4 spaces / 160 columns, matching house style).

### Swift

```bash
swift build
swift test
swift format --in-place --recursive --configuration .swift-format swift/Sources swift/Tests

# Or from root:
pnpm swift:build
pnpm swift:test
pnpm swift:format
pnpm swift:format:check
```

`.swift-format` at the repo root pins 4-space indent / 160 columns — swift-format
defaults to 2 spaces, which does not match the rest of the repo.

---

## Testing

- **TypeScript**: Vitest for unit tests, integration tests via `vitest.integration.config.mts`
- **Python**: pytest via `poe test`
- **Rust**: `cargo test` in `rust/config/`
- **Go**: `go test` in `go/config/`
- **.NET**: `dotnet test` in `dotnet/`
- **Kotlin**: `./gradlew test` in `kotlin/`
- **Swift**: `swift test` (root manifest)
- All tests must pass before merging

---

## CI / GitHub Actions

### PR Checks (`pr-checks.yml`)

Runs on every PR to `main`: typecheck, lint, format check, test, build (all languages)

### Release (`release.yml`)

Same checks + Changesets version/publish to npm, PyPI, crates.io, and Go module tagging.

---

## Changesets & Versioning

Always add changesets when the package changes:

```bash
pnpm changeset
```

---

## Coding Style

- TypeScript: oxlint + oxfmt
- Python: Ruff (lint + format) + BasedPyright (types)
- Rust: clippy + rustfmt
- Go: go vet + gofmt
