import { mkdirSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { findLocalConfigDir } from './schema-loader';

describe('schema-loader', () => {
    describe('findLocalConfigDir', () => {
        const rawTestDir = join(tmpdir(), `smooai-schema-test-${Date.now()}`);
        const originalCwd = process.cwd();
        let testDir: string;

        beforeAll(() => {
            mkdirSync(rawTestDir, { recursive: true });
            // Resolve macOS /var -> /private/var symlink
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
});
