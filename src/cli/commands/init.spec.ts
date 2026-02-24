import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initLogic } from './init';

describe('init command', () => {
    const testDir = join(tmpdir(), `smooai-init-test-${Date.now()}`);
    const originalCwd = process.cwd();

    beforeEach(() => {
        mkdirSync(testDir, { recursive: true });
        process.chdir(testDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        try {
            rmSync(testDir, { recursive: true });
        } catch {
            // ignore
        }
    });

    it('creates TypeScript config files by default', async () => {
        const result = await initLogic({});
        expect(result.success).toBe(true);
        expect(result.filesCreated).toContain('.smooai-config/');
        expect(result.filesCreated).toContain('.smooai-config/default.ts');
        expect(result.filesCreated).toContain('.smooai-config/development.ts');

        expect(existsSync(join(testDir, '.smooai-config', 'default.ts'))).toBe(true);
        expect(existsSync(join(testDir, '.smooai-config', 'development.ts'))).toBe(true);

        const defaultContent = readFileSync(join(testDir, '.smooai-config', 'default.ts'), 'utf-8');
        expect(defaultContent).toContain('defineConfig');
    });

    it('creates Python generator files for python language', async () => {
        const result = await initLogic({ language: 'python' });
        expect(result.success).toBe(true);
        expect(result.filesCreated).toContain('.smooai-config/schema_gen.py');
        expect(result.filesCreated).toContain('.smooai-config/development.json');

        expect(existsSync(join(testDir, '.smooai-config', 'schema_gen.py'))).toBe(true);

        const pyContent = readFileSync(join(testDir, '.smooai-config', 'schema_gen.py'), 'utf-8');
        expect(pyContent).toContain('define_config');
    });

    it('creates Go generator files for go language', async () => {
        const result = await initLogic({ language: 'go' });
        expect(result.success).toBe(true);
        expect(result.filesCreated).toContain('.smooai-config/main.go');
        expect(existsSync(join(testDir, '.smooai-config', 'main.go'))).toBe(true);
    });

    it('creates Rust generator files for rust language', async () => {
        const result = await initLogic({ language: 'rust' });
        expect(result.success).toBe(true);
        expect(result.filesCreated).toContain('.smooai-config/Cargo.toml');
        expect(result.filesCreated).toContain('.smooai-config/src/main.rs');
        expect(existsSync(join(testDir, '.smooai-config', 'Cargo.toml'))).toBe(true);
        expect(existsSync(join(testDir, '.smooai-config', 'src', 'main.rs'))).toBe(true);
    });

    it('creates JSON Schema for unknown languages', async () => {
        const result = await initLogic({ language: 'other' });
        expect(result.success).toBe(true);
        expect(result.filesCreated).toContain('.smooai-config/schema.json');
        expect(existsSync(join(testDir, '.smooai-config', 'schema.json'))).toBe(true);

        const schemaContent = JSON.parse(readFileSync(join(testDir, '.smooai-config', 'schema.json'), 'utf-8'));
        expect(schemaContent.$schema).toBe('http://json-schema.org/draft-07/schema#');
    });

    it('does not overwrite existing files', async () => {
        // First init
        await initLogic({});

        // Second init — should not recreate existing files
        const result = await initLogic({});
        expect(result.filesCreated).not.toContain('.smooai-config/default.ts');
    });

    it('adds local.* to .gitignore', async () => {
        // Create a .gitignore first
        const { writeFileSync } = await import('fs');
        writeFileSync(join(testDir, '.gitignore'), 'node_modules/\n');

        await initLogic({});

        const gitignore = readFileSync(join(testDir, '.gitignore'), 'utf-8');
        expect(gitignore).toContain('.smooai-config/local.*');
    });
});
