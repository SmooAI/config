/**
 * Load config schema from local .smooai-config/ directory.
 * Supports TypeScript (via defineConfig + serializeConfigSchema), raw JSON Schema,
 * and language-specific generators (Python, Go, Rust) that print JSON to stdout.
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

export interface LoadedSchema {
    format: 'typescript' | 'json-schema' | 'python-generator' | 'go-generator' | 'rust-generator';
    jsonSchema: Record<string, unknown>;
    filePath: string;
    /**
     * Optional canonical schema name declared by the config module itself
     * (e.g. `export const schemaName = 'smooai'`). When present, the `push`
     * command uses this instead of a cwd-basename fallback.
     */
    schemaName?: string;
}

/**
 * Find the project's .smooai-config directory, searching up from cwd.
 */
export function findLocalConfigDir(): string | null {
    let dir = process.cwd();
    const root = '/';

    for (let i = 0; i < 10; i++) {
        const candidate = join(dir, '.smooai-config');
        if (existsSync(candidate)) return candidate;
        const candidate2 = join(dir, 'smooai-config');
        if (existsSync(candidate2)) return candidate2;
        const parent = join(dir, '..');
        if (parent === dir || dir === root) break;
        dir = parent;
    }

    return null;
}

/**
 * Run a generator command and parse its JSON stdout output.
 */
function runGenerator(command: string, filePath: string, format: LoadedSchema['format']): LoadedSchema {
    try {
        const output = execSync(command, {
            encoding: 'utf-8',
            timeout: 30000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        return {
            format,
            jsonSchema: JSON.parse(output.trim()),
            filePath,
        };
    } catch (err) {
        throw new Error(`Failed to run generator ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/**
 * SMOODEV-643: load a TypeScript config module through `jiti`.
 *
 * Why jiti and not tsx's `tsImport`: the explicit type annotation
 *   `const config: ReturnType<typeof defineConfig> = defineConfig({...})`
 * — added in the smooai monorepo to work around a tsgo issue — trips tsx's
 * lightweight stripper with `SyntaxError: Missing initializer in const
 * declaration`. jiti uses a full TypeScript compiler path that handles
 * arbitrary TS, including complex type annotations and re-exports.
 */
async function loadTsConfigModule(tsPath: string): Promise<Record<string, unknown>> {
    // Dynamic import so the CLI bundle doesn't resolve jiti at import-graph
    // time (it's only needed when a project has a .ts config). We keep
    // `interopDefault: false` so named exports like `schemaName` survive — we
    // manually unwrap the default in `loadLocalSchema`.
    const { createJiti } = await import('jiti');
    const jiti = createJiti(pathToFileURL(tsPath).href, { interopDefault: false, moduleCache: false });
    const mod = (await jiti.import(tsPath)) as Record<string, unknown>;
    return mod;
}

function pickSchemaName(mod: Record<string, unknown>, configDef: Record<string, unknown>): string | undefined {
    const candidates = [configDef.schemaName, configDef.name, mod.schemaName, mod.name];
    for (const v of candidates) {
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
}

/**
 * Load config schema from .smooai-config/.
 *
 * Detection order:
 * 1. schema.json — raw JSON Schema (any language)
 * 2. default.ts / config.ts — TypeScript with defineConfig
 * 3. schema_gen.py — Python generator (prints JSON to stdout)
 * 4. main.go — Go generator (prints JSON to stdout)
 * 5. Cargo.toml — Rust generator (cargo run, prints JSON to stdout)
 */
export async function loadLocalSchema(configDir?: string): Promise<LoadedSchema | null> {
    const dir = configDir ?? findLocalConfigDir();
    if (!dir) return null;

    // 1. Check for JSON Schema first
    const jsonSchemaPath = join(dir, 'schema.json');
    if (existsSync(jsonSchemaPath)) {
        const raw = readFileSync(jsonSchemaPath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const schemaName = typeof parsed.$smooaiName === 'string' ? parsed.$smooaiName : undefined;
        return {
            format: 'json-schema',
            jsonSchema: parsed,
            filePath: jsonSchemaPath,
            schemaName,
        };
    }

    // 2. Fall back to TypeScript config
    const defaultTsPath = join(dir, 'default.ts');
    const configTsPath = join(dir, 'config.ts');
    const tsPath = existsSync(configTsPath) ? configTsPath : existsSync(defaultTsPath) ? defaultTsPath : null;

    if (tsPath) {
        try {
            const mod = await loadTsConfigModule(tsPath);
            const configDef = ((mod as { default?: Record<string, unknown> }).default ?? mod) as Record<string, unknown>;

            // SMOODEV-671: prefer the tiered JSON Schema wire format when the
            // config module exposes it. Older `@smooai/config` versions only
            // exported the flat `serializedAllConfigSchema` (internal
            // `{key: 'stringSchema'}` form); fall back to that so legacy
            // configs still push — though the UI won't render flat shapes
            // correctly until the producer bumps past 4.x.
            const tieredJsonSchema = configDef.serializedAllConfigSchemaJsonSchema as Record<string, unknown> | undefined;
            const flatSchema = configDef.serializedAllConfigSchema as Record<string, unknown> | undefined;
            if (tieredJsonSchema || flatSchema) {
                return {
                    format: 'typescript',
                    jsonSchema: (tieredJsonSchema ?? flatSchema) as Record<string, unknown>,
                    filePath: tsPath,
                    schemaName: pickSchemaName(mod, configDef),
                };
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`Failed to load TypeScript config from ${tsPath}: ${msg}`);
        }
    }

    // 3. Python generator
    const pyGenPath = join(dir, 'schema_gen.py');
    if (existsSync(pyGenPath)) {
        return runGenerator(`python3 "${pyGenPath}"`, pyGenPath, 'python-generator');
    }

    // 4. Go generator
    const goGenPath = join(dir, 'main.go');
    if (existsSync(goGenPath)) {
        return runGenerator(`go run "${goGenPath}"`, goGenPath, 'go-generator');
    }

    // 5. Rust generator (Cargo.toml)
    const cargoPath = join(dir, 'Cargo.toml');
    if (existsSync(cargoPath)) {
        return runGenerator(`cargo run --manifest-path "${cargoPath}"`, cargoPath, 'rust-generator');
    }

    return null;
}
