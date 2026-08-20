---
'@smooai/config': patch
---

Fix releases reaching npm only, and guard the five-registry lockstep.

Bumping `@changesets/cli` 2.x → 3.x (in the Dependabot sweep) changed its publish
output from `🦋 New tag: …` to `◇ Successfully published:`. `changesets/action@v1`
parses those lines to set its `published` output, so the output stayed **false** —
and every non-npm publish step is gated on it. All four skipped silently while the
release job reported success: 6.11.6, 6.11.7 and 6.12.0 went to npm alone, leaving
PyPI, crates.io, NuGet and the Go module tag stranded at 6.11.5.

`@changesets/cli` is pinned back to `^2.31.1`, which restores the output
`changesets/action@v1` expects and still audits clean (0 advisories — the bump was
only ever closing dev-tier transitives).

New `scripts/check-registry-parity.mjs` runs as the last release step and fails the
job if npm has a version the other four do not. It is deliberately **not** gated on
`published`, since conditioning it on the flag that broke would skip it in exactly
the failure case.
