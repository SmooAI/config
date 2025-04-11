import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as findUp from 'find-up';
import { glob } from 'glob';
import { join } from 'path';

import { directoryExists, findEnvConfigDirectory, findAndProcessEnvConfig } from './findAndProcessEnvConfig';

vi.mock('fs/promises');
vi.mock('find-up');
// Added: mock 'glob' so we can control which files are discovered
vi.mock('glob');

type DynamicImportFn = (path: string) => Promise<any>;

describe('envConfig', () => {
    const originalEnv = process.env;
    const originalCwd = process.cwd;

    beforeEach(() => {
        process.env = { ...originalEnv };
        vi.spyOn(process, 'cwd').mockReturnValue('/parent6/parent5/parent4/parent3/parent2/parent1/fake/cwd');
        vi.mocked(fs.stat).mockReset();
        vi.mocked(findUp.findUpMultiple).mockReset();
        vi.mocked(glob).mockReset();
    });

    afterEach(() => {
        process.env = originalEnv;
        process.cwd = originalCwd;
        vi.clearAllMocks();
    });

    //
    // 1) Tests for directoryExists
    //
    describe('directoryExists', () => {
        it('should return true for existing directory', async () => {
            vi.mocked(fs.stat).mockResolvedValueOnce({ isDirectory: () => true } as any);

            const result = await directoryExists('/some/path');
            expect(result).toBe(true);
            expect(fs.stat).toHaveBeenCalledWith('/some/path');
        });

        it('should return false for non-existing directory', async () => {
            vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

            const result = await directoryExists('/some/path');
            expect(result).toBe(false);
        });

        it('should return false for file that is not a directory', async () => {
            vi.mocked(fs.stat).mockResolvedValueOnce({ isDirectory: () => false } as any);

            const result = await directoryExists('/some/path');
            expect(result).toBe(false);
        });
    });

    //
    // 2) Tests for findEnvConfigDirectory
    //
    describe('findEnvConfigDirectory', () => {
        it('should use SMOOAI_ENV_CONFIG_DIR when set and directory exists', async () => {
            process.env.SMOOAI_ENV_CONFIG_DIR = '/custom/env/dir';
            vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as any);

            const result = await findEnvConfigDirectory();
            expect(result).toBe('/custom/env/dir');
        });

        it('should throw when SMOOAI_ENV_CONFIG_DIR is set but directory does not exist', async () => {
            process.env.SMOOAI_ENV_CONFIG_DIR = '/custom/env/dir';
            vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => false } as any);

            await expect(findEnvConfigDirectory()).rejects.toThrow(
                'The directory specified in the "SMOOAI_ENV_CONFIG_DIR" environment variable does not exist',
            );
        });

        it('should find local .smooai-env-config directory', async () => {
            vi.mocked(fs.stat).mockImplementation(
                async (path) =>
                    ({
                        isDirectory: () => path === '/parent6/parent5/parent4/parent3/parent2/parent1/fake/cwd/.smooai-env-config',
                    }) as any,
            );

            const result = await findEnvConfigDirectory();
            expect(result).toBe('/parent6/parent5/parent4/parent3/parent2/parent1/fake/cwd/.smooai-env-config');
        });

        it('should find directory in parent using find-up when local directories do not exist', async () => {
            vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => false } as any);
            vi.mocked(findUp.findUpMultiple).mockResolvedValueOnce(['/parent/path/.smooai-env-config']);

            const result = await findEnvConfigDirectory();
            expect(result).toBe('/parent/path/.smooai-env-config');
            expect(findUp.findUpMultiple).toHaveBeenCalledWith(['.smooai-env-config', 'smooai-env-config'], expect.any(Object));
        });

        it('should throw when no config directory is found', async () => {
            vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => false } as any);
            vi.mocked(findUp.findUpMultiple).mockResolvedValueOnce([]);

            await expect(findEnvConfigDirectory()).rejects.toThrow('Could not find the directory where the env config files are located');
        });

        it('should respect ignoreCache option', async () => {
            // First call to populate cache
            vi.mocked(fs.stat).mockImplementationOnce(
                async (path) =>
                    ({
                        isDirectory: () => path === '/parent6/parent5/parent4/parent3/parent2/parent1/fake/cwd/.smooai-env-config',
                    }) as any,
            );

            await findEnvConfigDirectory();

            // Second call with different mock but ignoreCache = false (should use cache)
            vi.mocked(fs.stat).mockImplementationOnce(
                async () =>
                    ({
                        isDirectory: () => true,
                    }) as any,
            );

            const cachedResult = await findEnvConfigDirectory();
            expect(cachedResult).toBe('/parent6/parent5/parent4/parent3/parent2/parent1/fake/cwd/.smooai-env-config');

            // Third call with ignoreCache = true (should bypass cache)
            vi.mocked(fs.stat).mockImplementation(
                async (path) =>
                    ({
                        isDirectory: () => path === '/parent6/parent5/parent4/parent3/parent2/parent1/fake/cwd/smooai-env-config',
                    }) as any,
            );

            const uncachedResult = await findEnvConfigDirectory({ ignoreCache: true });
            expect(uncachedResult).toBe('/parent6/parent5/parent4/parent3/parent2/parent1/fake/cwd/smooai-env-config');
        });

        it('should limit search to maximum of 5 levels up', async () => {
            vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => false } as any);

            await expect(findEnvConfigDirectory()).rejects.toThrow('Could not find the directory where the env config files are located.');

            expect(findUp.findUpMultiple).toHaveBeenCalledWith(['.smooai-env-config', 'smooai-env-config'], {
                type: 'directory',
                stopAt: join('/parent6/parent5/parent4/parent3/parent2/parent1/fake/cwd', '..', '..', '..', '..', '..'),
            });
        });

        it('should find config in the 5th parent directory', async () => {
            vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => false } as any);
            const fifthLevelPath = join('/parent6/parent5/parent4/parent3/parent2/parent1/fake/cwd', '..', '..', '..', '..', '.smooai-env-config');
            vi.mocked(findUp.findUpMultiple).mockResolvedValueOnce([fifthLevelPath]);

            const result = await findEnvConfigDirectory();
            expect(result).toBe(fifthLevelPath);
        });

        it('should not find config beyond 5th parent directory', async () => {
            vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => false } as any);
            const beyondFifthLevelPath = join('/parent6/parent5/parent4/parent3/parent2/parent1/fake/cwd', '..', '..', '..', '..', '..', '.smooai-env-config');
            vi.mocked(findUp.findUpMultiple).mockResolvedValueOnce([]);

            await expect(findEnvConfigDirectory()).rejects.toThrow('Could not find the directory where the env config files are located');
        });
    });

    //
    // 3) Tests for findAndProcessEnvConfig
    //
    describe('findAndProcessEnvConfig', () => {
        beforeEach(() => {
            // Reset any relevant environment variables
            process.env.IS_LOCAL = undefined;
            process.env.SMOOAI_CONFIG_ENV = undefined;
        });

        it('returns empty object if findEnvConfigDirectory fails', async () => {
            // Simulate that the directory is not found, causing findEnvConfigDirectory to throw
            vi.mocked(fs.stat).mockRejectedValueOnce(new Error('No directory found'));
            vi.mocked(findUp.findUpMultiple).mockResolvedValueOnce([]);

            // In your implementation, the top-level catch in findAndProcessEnvConfig
            // returns an empty object if anything fails before merging
            const result = await findAndProcessEnvConfig();
            expect(result).toEqual({});
        });

        it('throws if default.ts is missing', async () => {
            // Directory is found
            vi.mocked(fs.stat).mockResolvedValueOnce({ isDirectory: () => true } as any);
            vi.mocked(findUp.findUpMultiple).mockResolvedValueOnce(['/some/envConfig']);

            // No default.ts found by glob
            vi.mocked(glob).mockImplementation(async (pattern) => {
                if (pattern === 'default.ts') return [];
                return [];
            });

            await expect(async () => {
                await findAndProcessEnvConfig();
            }).rejects.toThrow(/Could not find required default config file in.*/);
        });

        it('throws if importing a config file fails', async () => {
            // Directory is found
            vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as any);
            vi.mocked(findUp.findUpMultiple).mockResolvedValueOnce(['/some/envConfig']);

            // We do see default.ts
            vi.mocked(glob).mockImplementation(async (pattern) => {
                if (pattern === 'default.ts') {
                    return ['/some/envConfig/default.ts'];
                }
                return [];
            });

            // Simulate an error in dynamic import
            (globalThis as Record<string, any>).import = vi.fn().mockImplementation(async (filePath: string) => {
                if (filePath.endsWith('default.ts')) {
                    throw new Error('Syntax error in default.ts');
                }
                return {};
            });

            await expect(findAndProcessEnvConfig()).rejects.toThrow('Syntax error in default.ts');
        });

        it('merges config files in the correct order (happy path)', async () => {
            // Directory found
            vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as any);
            vi.mocked(findUp.findUpMultiple).mockResolvedValueOnce(['/some/envConfig']);

            // Suppose user sets IS_LOCAL + SMOOAI_CONFIG_ENV
            process.env.IS_LOCAL = 'true';
            process.env.SMOOAI_CONFIG_ENV = 'development';

            // Let’s say your code automatically detects provider="aws" + region="us-east-1"
            // (depending on your getCloudRegion mock). We'll assume it returns that by default.

            // We'll simulate each file is found:
            vi.mocked(glob).mockImplementation(async (pattern) => {
                switch (pattern) {
                    case 'default.ts':
                        return ['/some/envConfig/default.ts'];
                    case 'local.ts':
                        return ['/some/envConfig/local.ts'];
                    case 'development.ts':
                        return ['/some/envConfig/development.ts'];
                    case 'development.aws.ts':
                        return ['/some/envConfig/development.aws.ts'];
                    case 'development.aws.us-east-1.ts':
                        return ['/some/envConfig/development.aws.us-east-1.ts'];
                    default:
                        return [];
                }
            });

            // Mock dynamic import for each file
            // We'll show array override logic
            (globalThis as Record<string, any>).import = vi.fn().mockImplementation(async (filePath: string) => {
                if (filePath.endsWith('default.ts')) {
                    return {
                        default: { name: 'default', arr: [1, 2], nested: { x: 10 } },
                    };
                }
                if (filePath.endsWith('local.ts')) {
                    return {
                        default: { name: 'local', arr: [100], localFlag: true },
                    };
                }
                if (filePath.endsWith('development.ts')) {
                    return {
                        default: { env: 'dev', arr: [200] },
                    };
                }
                if (filePath.endsWith('development.aws.ts')) {
                    return {
                        default: { provider: 'aws', arr: [300], nested: { y: 20 } },
                    };
                }
                if (filePath.endsWith('development.aws.us-east-1.ts')) {
                    return {
                        default: { region: 'us-east-1', arr: [999], nested: { x: 999 } },
                    };
                }
                return {};
            }) as DynamicImportFn;

            const finalConfig = await findAndProcessEnvConfig();
            // Arrays should be replaced in each step. The final arr = [999].
            expect(finalConfig).toEqual({
                name: 'local', // overwritten by local.ts
                arr: [999], // replaced step by step, last from development.aws.us-east-1
                localFlag: true,
                env: 'dev',
                provider: 'aws',
                region: 'us-east-1',
                nested: {
                    x: 999, // overwritten last
                    y: 20, // set from development.aws.ts
                },
            });
        });
    });
});
