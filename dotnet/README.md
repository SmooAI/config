# SmooAI.Config — .NET SDK

[![NuGet](https://img.shields.io/nuget/v/SmooAI.Config.svg?style=for-the-badge)](https://www.nuget.org/packages/SmooAI.Config)
[![License](https://img.shields.io/github/license/SmooAI/config?style=for-the-badge)](https://opensource.org/licenses/MIT)

**Type-safe config, secrets, and feature flags for .NET — same schema, same encrypted bundle, same source of truth as the TypeScript, Python, Rust, and Go clients.**

> **Note:** the `smooai-config` **CLI** (push / pull / list / set / diff / login) is TypeScript-only. The schema is authored in TS and pushed via the CLI; this .NET SDK only **reads** values at runtime. If you're on a .NET-only team and need the CLI, install it via Node: `pnpm add -g @smooai/config` (or `npm i -g @smooai/config`).

## Install

```sh
dotnet add package SmooAI.Config
```

## Five-line quickstart

```csharp
using SmooAI.Config;
using SmooAI.Config.Generated;
using SmooAI.Config.Runtime;

var runtime = SmooConfigRuntime.Load();        // decrypts SMOO_CONFIG_KEY_FILE at cold start
using var client = new SmooConfigClient(opts); // OAuth2 client for live values + flags
var apiUrl = await Public.ApiUrl.ResolveAsync(runtime, client);
```

A Roslyn source generator turns the keys in `schema.json` into compile-checked properties (`Public.ApiUrl`, `Secrets.MoonshotApiKey`, `FeatureFlags.NewFlow`). Rename a key in the schema and every call site becomes a build error — exactly like every other SDK in this repo.

## Read the full docs

The canonical user-facing README is the one packed into the NuGet package:

**→ [`src/SmooAI.Config/README.md`](src/SmooAI.Config/README.md)**

It covers:

- Quickstart with the source generator + typed keys
- `SmooConfigRuntime` (AES-256-GCM blob, sync reads, no network)
- `SmooConfigClient` (OAuth2, live values, feature flags)
- `ConfigKey<T>.ResolveAsync` (runtime-first, HTTP fall-through)
- Bake-the-bundle flow (`SmooConfigBuilder.BuildAsync` + `SchemaClassifier.FromSchemaFile`)
- The `SMOO_CONFIG_KEY_FILE` / `SMOO_CONFIG_KEY` env-var contract
- Wire compatibility with the TypeScript, Python, Rust, and Go runtimes
- Common errors (typed-key not generated, AES-GCM decryption failed)

The .NET package's NuGet `PackageReadmeFile` is wired to that file, so the docs you see on the package page are the authoritative source.

## Repo layout

| Path                                         | What                                                      |
| -------------------------------------------- | --------------------------------------------------------- |
| `src/SmooAI.Config/`                         | Main library (client, runtime, builder, models, OAuth).   |
| `src/SmooAI.Config.SourceGenerator/`         | Roslyn analyzer that emits typed keys from `schema.json`. |
| `tests/SmooAI.Config.Tests/`                 | xUnit tests (client, runtime, builder, priority chain).   |
| `tests/SmooAI.Config.SourceGenerator.Tests/` | Source-generator snapshot + behaviour tests.              |
| `SmooAI.Config.sln`                          | Solution file.                                            |

## Develop

```sh
# Build everything
dotnet build

# Run the test suite
dotnet test

# Run only the priority-chain integration tests
dotnet test --filter "FullyQualifiedName~PriorityChain"

# Run only the source-generator tests
dotnet test tests/SmooAI.Config.SourceGenerator.Tests
```

The package targets `net8.0`, `net9.0`, and `net10.0`. CI gates are wired through `.github/workflows/release.yml`.

## All Language Packages

| Language   | Package                                                          | Install                                     |
| ---------- | ---------------------------------------------------------------- | ------------------------------------------- |
| TypeScript | [`@smooai/config`](https://www.npmjs.com/package/@smooai/config) | `pnpm add @smooai/config`                   |
| Python     | [`smooai-config`](https://pypi.org/project/smooai-config/)       | `pip install smooai-config`                 |
| Rust       | [`smooai-config`](https://crates.io/crates/smooai-config)        | `cargo add smooai-config`                   |
| Go         | `github.com/SmooAI/config/go/config`                             | `go get github.com/SmooAI/config/go/config` |
| **.NET**   | [`SmooAI.Config`](https://www.nuget.org/packages/SmooAI.Config)  | `dotnet add package SmooAI.Config`          |

## License

MIT © SmooAI
