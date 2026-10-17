---
'@smooai/config': patch
---

Stop logging at ERROR when there is no `.smooai-config/` directory (or it has no `default.ts`). In container / baked-blob mode that is the expected state and the server accessor already skips the file tier, so every cold init was emitting a spurious ERROR. `findAndProcessFileConfig` still throws, now a `SmooaiConfigFilesNotFoundError` (check with `isConfigFilesNotFoundError`), and logs it at debug; the file-tier skip logs at info. A config file that exists but fails to import or parse still logs at ERROR (and the tier skip at WARN), as does an `SMOOAI_ENV_CONFIG_DIR` pointing at a missing directory.
