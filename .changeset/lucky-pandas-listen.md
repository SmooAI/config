---
'@smooai/config': patch
---

`go test` was serving cached passes against the shared fixture — add `-count=1`.

`go/config/schema_validator_test.go` loads `test-fixtures/schema-validation-cases.json`
from outside its package directory. Go's test cache keys on package inputs and
does not notice that file changing, so `go test ./...` reported `ok (cached)`
against a deliberately corrupted corpus while TypeScript, Python, Rust and .NET
all went red on the same edit. Go was the only one of the five that failed open.

A fixture loader that cannot fail is worse than no loader, because it reads as
coverage. `go:test` now passes `-count=1`, verified to turn red on the same
corruption, with the reason recorded at `loadFixtures` so the flag does not get
tidied away later.
