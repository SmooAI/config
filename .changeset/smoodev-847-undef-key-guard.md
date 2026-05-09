---
'@smooai/config': minor
---

Throw a clear error when `secretConfig.get()` / `publicConfig.get()` /
`featureFlag.get()` (or their `getSync` siblings) receive `undefined` /
`null` / non-string keys, instead of cascading into `envVarNameFor`'s
`undefined.replace(...)` and surfacing as the cryptic
`Cannot read properties of undefined (reading 'replace')`.

Most common cause: reading `SecretConfigKeys.<X>` (or
`PublicConfigKeys.<X>` / `FeatureFlagKeys.<X>`) for a key that wasn't
declared in the consumer's schema. The new error spells that out and
points at `smooai-config push`. Cost real prod debug time on
SMOODEV-841 — the route handler crashed deep inside `@smooai/config`'s
internals while the actual fix was one declaration in
`.smooai-config/config.ts`.
