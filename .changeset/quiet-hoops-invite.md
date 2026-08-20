---
'@smooai/config': patch
---

Make `check-all` actually mean full CI parity, and add the three missing formatters.

`pnpm test` / `build` / `check-all` covered only TypeScript, Python, Rust and Go,
so the script CLAUDE.md called "full CI parity" missed 3 of the 7 language SDKs.
`.NET`, Kotlin and Swift are now wired into `build`, `test`, `format` and
`format:check`, each via `scripts/with-toolchain.mjs`: a missing toolchain is an
explicit skip locally, and a **hard failure under CI** unless the workflow named
it in `SMOOAI_SKIP_TOOLCHAINS`.

There was also no `dotnet format`, no ktlint and no swift-format anywhere in the
repo, so three languages' formatting had never been verified once. All three are
added and the drift they surfaced is fixed: 30 ktlint violations across the
Kotlin source and tests, 28 swift-format violations, and whitespace in one .NET
test file. `.swift-format` and `kotlin/.editorconfig` pin 4-space / 160-column to
match the house style the other four languages already format to.
