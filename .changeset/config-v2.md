---
'@smooai/config': major
---

## @smooai/config v2.0.0

### Cross-Language Schema Validation

- Add `validateSmooaiSchema()` — validates JSON Schema uses only the cross-language-compatible subset
- TypeScript: Pre-validation detects unsupported Zod types (z.function, z.transform, z.lazy, z.map, z.set, z.bigint, z.date) with actionable errors
- Python: Pre-validation detects unsupported Pydantic features (computed_field, Callable fields)
- Rust/Go: Post-conversion validation on generated JSON Schema
- Shared test fixtures ensure identical behavior across all 4 languages

### Native Type to JSON Schema in Rust and Go

- Rust: `define_config_typed::<P, S, F>()` using schemars for compile-time type-safe schema generation
- Go: `DefineConfigTyped()` using invopop/jsonschema for struct-based schema generation
- Both validate generated schemas via the cross-language validation layer

### Project File Convention for All Languages

- Language-specific generator files: `.smooai-config/schema_gen.py`, `.smooai-config/main.go`, `.smooai-config/Cargo.toml`
- CLI `init` generates language-appropriate templates
- CLI `push` auto-detects and runs generators
- Fallback to `.smooai-config/schema.json` for any language

### Deferred/Computed Config Values

- Python: `resolve_deferred_values()` — callable config overrides resolved after merge
- Rust: `.with_deferred(key, closure)` builder on ConfigManager
- Go: `WithDeferred(key, fn)` option on ConfigManager
- All languages resolve against pre-resolution config snapshot

### Comprehensive Mock-Based Integration Tests

- TS CliApiClient: 44 MSW tests covering auth, schema CRUD, environments, values, error handling, helper methods, and full workflows
- Rust ConfigClient: 9 wiremock tests covering get/getAll, auth, caching, TTL, invalidation, errors, and per-environment isolation
- Complements existing mock tests: TS ConfigClient (MSW + real HTTP server), Python (httpx.MockTransport), Go (httptest.Server), Rust ConfigManager (wiremock)

### Published as Public Package

- Package published to npm as `@smooai/config` (public access)
- Removed SST dependency (E2E tests moved to main monorepo)
