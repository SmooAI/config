import { mkdirSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { findLocalConfigDir, loadLocalSchema } from './schema-loader';

describe('schema-loader', () => {
    describe('findLocalConfigDir', () => {
        const rawTestDir = join(tmpdir(), `smooai-schema-test-${Date.now()}`);
        const originalCwd = process.cwd();
        let testDir: string;

        beforeAll(() => {
            mkdirSync(rawTestDir, { recursive: true });
            testDir = realpathSync(rawTestDir);
        });

        afterAll(() => {
            process.chdir(originalCwd);
            try {
                rmSync(rawTestDir, { recursive: true });
            } catch {
                // ignore
            }
        });

        it('returns null when no config dir exists', () => {
            const subDir = join(testDir, 'empty');
            mkdirSync(subDir, { recursive: true });
            process.chdir(subDir);
            expect(findLocalConfigDir()).toBeNull();
        });

        it('finds .smooai-config in current directory', () => {
            const subDir = join(testDir, 'test1');
            mkdirSync(subDir, { recursive: true });
            const configDir = join(subDir, '.smooai-config');
            mkdirSync(configDir);
            process.chdir(subDir);
            expect(findLocalConfigDir()).toBe(configDir);
        });

        it('finds smooai-config in current directory', () => {
            const subDir = join(testDir, 'test2');
            mkdirSync(subDir, { recursive: true });
            const configDir = join(subDir, 'smooai-config');
            mkdirSync(configDir);
            process.chdir(subDir);
            expect(findLocalConfigDir()).toBe(configDir);
        });

        it('prefers .smooai-config over smooai-config', () => {
            const subDir = join(testDir, 'test3');
            mkdirSync(subDir, { recursive: true });
            const dotDir = join(subDir, '.smooai-config');
            const plainDir = join(subDir, 'smooai-config');
            mkdirSync(dotDir);
            mkdirSync(plainDir);
            process.chdir(subDir);
            expect(findLocalConfigDir()).toBe(dotDir);
        });
    });

    describe('loadLocalSchema (TypeScript via jiti)', () => {
        const FIXTURES = resolve(__dirname, '../../../test-fixtures/cli-schema-loader');

        it('loads a TS config with explicit ReturnType<typeof defineConfig> annotation', async () => {
            // SMOODEV-643: this annotation previously crashed tsx's stripper.
            const loaded = await loadLocalSchema(join(FIXTURES, 'annotated/.smooai-config'));
            expect(loaded).not.toBeNull();
            expect(loaded!.format).toBe('typescript');
            expect(loaded!.jsonSchema).toMatchObject({ type: 'object', properties: { API_URL: { type: 'string' } } });
            expect(loaded!.schemaName).toBe('fixture-annotated');
        });

        it('reads schemaName from the default-export object when present', async () => {
            const loaded = await loadLocalSchema(join(FIXTURES, 'named/.smooai-config'));
            expect(loaded).not.toBeNull();
            expect(loaded!.schemaName).toBe('fixture-via-default');
            expect(loaded!.jsonSchema).toMatchObject({ properties: { DEBUG: { type: 'boolean' } } });
        });

        it('reads $smooaiName from schema.json', async () => {
            const loaded = await loadLocalSchema(join(FIXTURES, 'json-named/.smooai-config'));
            expect(loaded).not.toBeNull();
            expect(loaded!.format).toBe('json-schema');
            expect(loaded!.schemaName).toBe('fixture-json');
        });
    });
});
