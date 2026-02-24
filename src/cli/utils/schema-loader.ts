/**
 * Load config schema from local .smooai-config/ directory.
 * Supports TypeScript (via defineConfig + serializeConfigSchema), raw JSON Schema,
 * and language-specific generators (Python, Go, Rust) that print JSON to stdout.
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface LoadedSchema {
    format: 'typescript' | 'json-schema' | 'python-generator' | 'go-generator' | 'rust-generator';
    jsonSchema: Record<string, unknown>;
    filePath: string;
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
        return {
            format: 'json-schema',
            jsonSchema: JSON.parse(raw),
            filePath: jsonSchemaPath,
        };
    }

    // 2. Fall back to TypeScript config
    const defaultTsPath = join(dir, 'default.ts');
    const configTsPath = join(dir, 'config.ts');
    const tsPath = existsSync(configTsPath) ? configTsPath : existsSync(defaultTsPath) ? defaultTsPath : null;

    if (tsPath) {
        try {
            const mod = await import(tsPath);
            const configDef = mod.default ?? mod;
            if (configDef.serializedAllConfigSchema) {
                return {
                    format: 'typescript',
                    jsonSchema: configDef.serializedAllConfigSchema,
                    filePath: tsPath,
                };
            }
        } catch (err) {
            throw new Error(`Failed to load TypeScript config from ${tsPath}: ${err}`);
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
