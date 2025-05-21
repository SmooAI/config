/* eslint-disable @typescript-eslint/no-explicit-any -- ok */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import { any as findAny } from 'empathic/find';
import { glob } from 'glob';
import { join } from 'path';

import { findConfigDirectory, findAndProcessConfig } from './findAndProcessConfig';
import { envToUse, directoryExists, importFile } from './utils';
import { getCloudRegion } from './getCloudRegion';
import { defineConfig, StringSchema } from './config';
import { z } from 'zod';

vi.mock('fs/promises');
vi.mock('empathic/find');
vi.mock('glob');
vi.mock('./utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./utils')>();
    return {
        ...actual,
        envToUse: vi.fn(),
        directoryExists: vi.fn(),
        importFile: vi.fn(),
    };
});
vi.mock('./getCloudRegion');
vi.mock('@smooai/logger/Logger');

describe('findAndProcessConfig', () => {
    const originalEnv = process.env;
    const originalCwd = process.cwd;

    beforeEach(() => {
        process.env = { ...originalEnv };
        vi.spyOn(process, 'cwd').mockReturnValue('/parent6/parent5/parent4/parent3/parent2/parent1/fake/cwd');
        vi.mocked(fs.stat).mockReset();
        vi.mocked(findAny).mockReset();
        vi.mocked(glob).mockReset();
        vi.mocked(envToUse).mockReturnValue({});
        vi.mocked(directoryExists).mockReset();
        vi.mocked(getCloudRegion).mockResolvedValue({ provider: 'aws', region: 'us-east-1' });
    });

    afterEach(() => {
        process.env = originalEnv;
        process.cwd = originalCwd;
        vi.clearAllMocks();
    });

    //
    // 1) Tests for findConfigDirectory
    //
    describe('findConfigDirectory', () => {
        it('should use SMOOAI_ENV_CONFIG_DIR when set and directory exists', async () => {
            vi.mocked(envToUse).mockReturnValue({ SMOOAI_ENV_CONFIG_DIR: '/custom/env/dir' });
            vi.mocked(directoryExists).mockResolvedValue(true);

            const result = await findConfigDirectory();
            expect(result).toBe('/custom/env/dir');
        });

        it('should throw when SMOOAI_ENV_CONFIG_DIR is set but directory does not exist', async () => {
            vi.mocked(envToUse).mockReturnValue({ SMOOAI_ENV_CONFIG_DIR: '/custom/env/dir' });
            vi.mocked(directoryExists).mockResolvedValue(false);

            await expect(findConfigDirectory()).rejects.toThrow(
                'The directory specified in the "SMOOAI_ENV_CONFIG_DIR" environment variable does not exist: /custom/env/dir',
            );
        });

        it('should find local .smooai-config directory', async () => {
            vi.mocked(directoryExists).mockImplementation(async (path) => path === '/parent6/parent5/parent4/parent3/parent2/parent1/fake/cwd/.smooai-config');

            const result = await findConfigDirectory();
            expect(result).toBe('/parent6/parent5/parent4/parent3/parent2/parent1/fake/cwd/.smooai-config');
        });

        it('should find directory in parent using empathic/find.any when local directories do not exist', async () => {
            vi.mocked(directoryExists).mockImplementation((path) => {
                if (path === '/parent/path/.smooai-config') {
                    return Promise.resolve(true);
                }
                return Promise.resolve(false);
            });
            vi.mocked(findAny).mockResolvedValueOnce('/parent/path/.smooai-config');

            const result = await findConfigDirectory();
            expect(result).toBe('/parent/path/.smooai-config');
            expect(findAny).toHaveBeenCalledWith(['.smooai-config', 'smooai-config'], expect.any(Object));
        });

        it('should throw when no config directory is found', async () => {
            vi.mocked(directoryExists).mockResolvedValue(false);
            vi.mocked(findAny).mockResolvedValueOnce(undefined);

            await expect(findConfigDirectory()).rejects.toThrow('Could not find the directory where the config files are located.');
        });

        it('should respect ignoreCache option', async () => {
            // First call to populate cache
            vi.mocked(directoryExists).mockImplementationOnce(
                async (path) => path === '/parent6/parent5/parent4/parent3/parent2/parent1/fake/cwd/.smooai-config',
            );

            await findConfigDirectory();

            // Second call with different mock but ignoreCache = false (should use cache)
            vi.mocked(directoryExists).mockImplementationOnce(async () => true);

            const cachedResult = await findConfigDirectory();
            expect(cachedResult).toBe('/parent6/parent5/parent4/parent3/parent2/parent1/fake/cwd/.smooai-config');

            // Third call with ignoreCache = true (should bypass cache)
            vi.mocked(directoryExists).mockImplementation(async (path) => path === '/parent6/parent5/parent4/parent3/parent2/parent1/fake/cwd/smooai-config');

            const uncachedResult = await findConfigDirectory({ ignoreCache: true });
            expect(uncachedResult).toBe('/parent6/parent5/parent4/parent3/parent2/parent1/fake/cwd/smooai-config');
        });

        it('should limit search to maximum of 5 levels up', async () => {
            vi.mocked(directoryExists).mockResolvedValue(false);

            await expect(findConfigDirectory()).rejects.toThrow('Could not find the directory where the config files are located.');

            expect(findAny).toHaveBeenCalledWith(['.smooai-config', 'smooai-config'], {
                cwd: expect.any(String),
                stop: join('/parent6/parent5/parent4/parent3/parent2/parent1/fake/cwd', '..', '..', '..', '..', '..'),
            });
        });
    });

    //
    // 2) Tests for findAndProcessConfig
    //
    describe('findAndProcessConfig', () => {
        beforeEach(() => {
            vi.mocked(envToUse).mockReturnValue({
                IS_LOCAL: undefined,
                SMOOAI_CONFIG_ENV: undefined,
            });
        });

        it('returns empty object if findConfigDirectory fails', async () => {
            vi.mocked(directoryExists).mockRejectedValueOnce(new Error('No directory found'));
            vi.mocked(findAny).mockResolvedValueOnce(undefined);

            await expect(findAndProcessConfig()).rejects.toThrow('Could not find the directory where the config files are located.');
        });

        it('throws if default.ts is missing', async () => {
            vi.mocked(directoryExists).mockResolvedValue(true);
            vi.mocked(findAny).mockResolvedValueOnce('/some/config');
            vi.mocked(glob).mockResolvedValue([]);

            vi.mocked(importFile).mockImplementation(async (filePath: string) => {
                const configs: Record<string, any> = {
                    'config.ts': { name: 'config', arr: [1, 2], nested: { x: 10 } },
                };
                return configs[filePath.split('/').pop()!];
            });

            await expect(findAndProcessConfig()).rejects.toThrow(/The config.ts file must have a default export that is the result of/);
        });

        it('throws if importing a config file fails', async () => {
            vi.mocked(directoryExists).mockResolvedValue(true);
            vi.mocked(findAny).mockResolvedValueOnce('/some/config');
            vi.mocked(glob).mockImplementation(async (pattern) => {
                if (pattern === 'default.ts') return ['/some/config/default.ts'];
                return [];
            });

            vi.mocked(importFile).mockRejectedValue(new Error('Syntax error in default.ts'));

            await expect(findAndProcessConfig()).rejects.toThrow('Syntax error in default.ts');
        });

        it('merges config files in the correct order (happy path)', async () => {
            vi.mocked(directoryExists).mockResolvedValue(true);
            vi.mocked(findAny).mockResolvedValueOnce('/some/config');
            vi.mocked(envToUse).mockReturnValue({
                IS_LOCAL: 'true',
                SMOOAI_CONFIG_ENV: 'development',
            });

            vi.mocked(glob).mockImplementation(async (pattern) => {
                switch (pattern) {
                    case 'config.ts':
                        return ['/some/config/config.ts'];
                    case 'default.ts':
                        return ['/some/config/default.ts'];
                    case 'local.ts':
                        return ['/some/config/local.ts'];
                    case 'development.ts':
                        return ['/some/config/development.ts'];
                    case 'development.aws.ts':
                        return ['/some/config/development.aws.ts'];
                    case 'development.aws.us-east-1.ts':
                        return ['/some/config/development.aws.us-east-1.ts'];
                    default:
                        return [];
                }
            });

            vi.mocked(importFile).mockImplementation(async (filePath: string) => {
                const configs: Record<string, any> = {
                    'config.ts': {
                        default: defineConfig({
                            publicConfigSchema: {
                                name: StringSchema,
                                arr: z.array(z.number()),
                                nested: z.object({
                                    x: z.number().optional(),
                                    y: z.number().optional(),
                                }),
                            },
                        }),
                    },
                    'default.ts': { name: 'default', arr: [1, 2], nested: { x: 10 } },
                    'local.ts': { name: 'local', arr: [100], localFlag: true },
                    'development.ts': { arr: [200] },
                    'development.aws.ts': { arr: [300], nested: { y: 20 } },
                    'development.aws.us-east-1.ts': { arr: [999], nested: { x: 999 } },
                };
                return configs[filePath.split('/').pop()!];
            });

            const finalConfig = await findAndProcessConfig();
            expect(finalConfig).toEqual({
                name: 'local',
                arr: [999],
                IS_LOCAL: true,
                ENV: 'development',
                CLOUD_PROVIDER: 'aws',
                REGION: 'us-east-1',
                nested: {
                    x: 999,
                    y: 20,
                },
            });
        });
    });
});
