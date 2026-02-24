/**
 * Load config schema from local .smooai-config/ directory.
 * Supports TypeScript (via defineConfig + serializeConfigSchema) and raw JSON Schema.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface LoadedSchema {
    format: 'typescript' | 'json-schema';
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
 * Load config schema from .smooai-config/.
 * Checks for schema.json first, then falls back to default.ts.
 */
export async function loadLocalSchema(configDir?: string): Promise<LoadedSchema | null> {
    const dir = configDir ?? findLocalConfigDir();
    if (!dir) return null;

    // Check for JSON Schema first
    const jsonSchemaPath = join(dir, 'schema.json');
    if (existsSync(jsonSchemaPath)) {
        const raw = readFileSync(jsonSchemaPath, 'utf-8');
        return {
            format: 'json-schema',
            jsonSchema: JSON.parse(raw),
            filePath: jsonSchemaPath,
        };
    }

    // Fall back to TypeScript config
    const defaultTsPath = join(dir, 'default.ts');
    const configTsPath = join(dir, 'config.ts');
    const tsPath = existsSync(configTsPath) ? configTsPath : existsSync(defaultTsPath) ? defaultTsPath : null;

    if (tsPath) {
        try {
            // Dynamic import with tsx support (already a dependency)
            const mod = await import(tsPath);
            const configDef = mod.default ?? mod;

            // If it has serializedAllConfigSchema, it's a defineConfig result
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

    return null;
}
