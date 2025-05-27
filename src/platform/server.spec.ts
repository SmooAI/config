import { describe, it, expect, vi, beforeEach } from 'vitest';
import buildConfigObject from './server';
import { defineConfig } from '@/config/config';
import { z } from 'zod';
import { findAndProcessFileConfig } from '@/config/findAndProcessFileConfig';
import { findAndProcessEnvConfig } from '@/config/findAndProcessEnvConfig';

// Mock dependencies
vi.mock('@/config/findAndProcessFileConfig', () => ({
    findAndProcessFileConfig: vi.fn(),
}));

vi.mock('@/config/findAndProcessEnvConfig', () => ({
    findAndProcessEnvConfig: vi.fn(),
}));

describe('server', () => {
    const testConfig = defineConfig({
        publicConfigSchema: {
            api: z.object({
                baseUrl: z.string(),
                version: z.string(),
                timeout: z.number(),
                retries: z.number(),
                endpoints: z.object({
                    users: z.string(),
                    products: z.string(),
                    orders: z.string(),
                }),
                auth: z.object({
                    type: z.enum(['basic', 'bearer', 'oauth2']),
                    scopes: z.array(z.string()),
                }),
            }),
            database: z.object({
                host: z.string(),
                port: z.number(),
                name: z.string(),
                pool: z.object({
                    min: z.number(),
                    max: z.number(),
                    idleTimeout: z.number(),
                }),
            }),
            logging: z.object({
                level: z.enum(['debug', 'info', 'warn', 'error']),
                format: z.enum(['json', 'text']),
                destination: z.enum(['console', 'file', 'syslog']),
                retention: z.number(),
            }),
            featureFlags: z.object({
                enableBeta: z.boolean(),
                enableMetrics: z.boolean(),
                enableCaching: z.boolean(),
            }),
        },
        secretConfigSchema: {
            apiKeys: z.object({
                primary: z.string(),
                backup: z.string(),
            }),
            dbCredentials: z.object({
                username: z.string(),
                password: z.string(),
                sslCert: z.string(),
            }),
            jwt: z.object({
                secret: z.string(),
                algorithm: z.enum(['HS256', 'HS512', 'RS256']),
                expiresIn: z.string(),
            }),
        },
        featureFlagSchema: {
            experimental: z.object({
                newAuth: z.boolean(),
                newUI: z.boolean(),
                newAPI: z.boolean(),
            }),
            beta: z.object({
                darkMode: z.boolean(),
                analytics: z.boolean(),
                notifications: z.boolean(),
            }),
            maintenance: z.object({
                readOnly: z.boolean(),
                scheduled: z.boolean(),
                backup: z.boolean(),
            }),
        },
    });

    const mockFileConfig = {
        config: {
            api: {
                baseUrl: 'https://api.example.com',
                version: 'v2',
                timeout: 5000,
                retries: 3,
                endpoints: {
                    users: '/users',
                    products: '/products',
                    orders: '/orders',
                },
                auth: {
                    type: 'oauth2',
                    scopes: ['read', 'write', 'admin'],
                },
            },
            database: {
                host: 'db.example.com',
                port: 5432,
                name: 'production',
                pool: {
                    min: 5,
                    max: 20,
                    idleTimeout: 30000,
                },
            },
            logging: {
                level: 'info',
                format: 'json',
                destination: 'file',
                retention: 30,
            },
            featureFlags: {
                enableBeta: true,
                enableMetrics: true,
                enableCaching: false,
            },
            apiKeys: {
                primary: 'file-primary-key',
                backup: 'file-backup-key',
            },
            dbCredentials: {
                username: 'file-db-user',
                password: 'file-db-pass',
                sslCert: 'file-ssl-cert',
            },
            jwt: {
                secret: 'file-jwt-secret',
                algorithm: 'HS256',
                expiresIn: '1d',
            },
            experimental: {
                newAuth: true,
                newUI: false,
                newAPI: true,
            },
            beta: {
                darkMode: true,
                analytics: false,
                notifications: true,
            },
            maintenance: {
                readOnly: false,
                scheduled: true,
                backup: true,
            },
        },
    };

    const mockEnvConfig = {
        config: {
            api: {
                baseUrl: 'https://env-api.example.com',
                version: 'v1',
                timeout: 3000,
                retries: 2,
                endpoints: {
                    users: '/api/users',
                    products: '/api/products',
                    orders: '/api/orders',
                },
                auth: {
                    type: 'bearer',
                    scopes: ['read'],
                },
            },
            database: {
                host: 'env-db.example.com',
                port: 5433,
                name: 'staging',
                pool: {
                    min: 2,
                    max: 10,
                    idleTimeout: 15000,
                },
            },
            logging: {
                level: 'debug',
                format: 'text',
                destination: 'console',
                retention: 7,
            },
            featureFlags: {
                enableBeta: false,
                enableMetrics: false,
                enableCaching: true,
            },
            apiKeys: {
                primary: 'env-primary-key',
                backup: 'env-backup-key',
            },
            dbCredentials: {
                username: 'env-db-user',
                password: 'env-db-pass',
                sslCert: 'env-ssl-cert',
            },
            jwt: {
                secret: 'env-jwt-secret',
                algorithm: 'HS512',
                expiresIn: '2d',
            },
            experimental: {
                newAuth: false,
                newUI: true,
                newAPI: false,
            },
            beta: {
                darkMode: false,
                analytics: true,
                notifications: false,
            },
            maintenance: {
                readOnly: true,
                scheduled: false,
                backup: false,
            },
        },
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(findAndProcessFileConfig).mockResolvedValue(mockFileConfig);
        vi.mocked(findAndProcessEnvConfig).mockReturnValue(mockEnvConfig);
    });

    it('should initialize config with file and env configs', async () => {
        const config = buildConfigObject(testConfig);

        // Test public config
        const publicConfig = await config.publicConfig.getAsync('api');
        expect(publicConfig).toEqual({
            baseUrl: 'https://api.example.com',
            version: 'v2',
            timeout: 5000,
            retries: 3,
            endpoints: {
                users: '/users',
                products: '/products',
                orders: '/orders',
            },
            auth: {
                type: 'oauth2',
                scopes: ['read', 'write', 'admin'],
            },
        });

        // Test secret config
        const secretConfig = await config.secretConfig.getAsync('apiKeys');
        expect(secretConfig).toEqual({
            primary: 'file-primary-key',
            backup: 'file-backup-key',
        });

        // Test feature flag
        const featureFlag = await config.featureFlag.getAsync('experimental');
        expect(featureFlag).toEqual({
            newAuth: true,
            newUI: false,
            newAPI: true,
        });
    });

    it('should use cached configs on subsequent calls', async () => {
        const config = buildConfigObject(testConfig);

        // First call should load configs
        await config.publicConfig.getAsync('api');
        expect(findAndProcessFileConfig).toHaveBeenCalledTimes(1);
        expect(findAndProcessEnvConfig).toHaveBeenCalledTimes(1);

        // Second call should use cached configs
        await config.publicConfig.getAsync('api');
        expect(findAndProcessFileConfig).toHaveBeenCalledTimes(1);
        expect(findAndProcessEnvConfig).toHaveBeenCalledTimes(1);
    });

    describe('public config', () => {
        it('should get public config values', async () => {
            const config = buildConfigObject(testConfig);

            // Test async get
            const asyncValue = await config.publicConfig.getAsync('api');
            expect(asyncValue).toEqual({
                baseUrl: 'https://api.example.com',
                version: 'v2',
                timeout: 5000,
                retries: 3,
                endpoints: {
                    users: '/users',
                    products: '/products',
                    orders: '/orders',
                },
                auth: {
                    type: 'oauth2',
                    scopes: ['read', 'write', 'admin'],
                },
            });

            // Test sync get
            const syncValue = config.publicConfig.getSync('api');
            expect(syncValue).toEqual({
                baseUrl: 'https://api.example.com',
                version: 'v2',
                timeout: 5000,
                retries: 3,
                endpoints: {
                    users: '/users',
                    products: '/products',
                    orders: '/orders',
                },
                auth: {
                    type: 'oauth2',
                    scopes: ['read', 'write', 'admin'],
                },
            });
        });

        it('should return undefined for non-existent public config', async () => {
            const config = buildConfigObject(testConfig);

            // Test async get
            const asyncValue = await config.publicConfig.getAsync('nonExistentKey' as any);
            expect(asyncValue).toBeUndefined();

            // Test sync get
            const syncValue = config.publicConfig.getSync('nonExistentKey' as any);
            expect(syncValue).toBeUndefined();
        });
    });

    describe('secret config', () => {
        it('should get secret config values', async () => {
            const config = buildConfigObject(testConfig);

            // Test async get
            const asyncValue = await config.secretConfig.getAsync('apiKeys');
            expect(asyncValue).toEqual({
                primary: 'file-primary-key',
                backup: 'file-backup-key',
            });

            // Test sync get
            const syncValue = config.secretConfig.getSync('apiKeys');
            expect(syncValue).toEqual({
                primary: 'file-primary-key',
                backup: 'file-backup-key',
            });
        });

        it('should return undefined for non-existent secret config', async () => {
            const config = buildConfigObject(testConfig);

            // Test async get
            const asyncValue = await config.secretConfig.getAsync('nonExistentKey' as any);
            expect(asyncValue).toBeUndefined();

            // Test sync get
            const syncValue = config.secretConfig.getSync('nonExistentKey' as any);
            expect(syncValue).toBeUndefined();
        });
    });

    describe('feature flags', () => {
        it('should get feature flag values', async () => {
            const config = buildConfigObject(testConfig);

            // Test async get
            const asyncValue = await config.featureFlag.getAsync('experimental');
            expect(asyncValue).toEqual({
                newAuth: true,
                newUI: false,
                newAPI: true,
            });

            // Test sync get
            const syncValue = config.featureFlag.getSync('experimental');
            expect(syncValue).toEqual({
                newAuth: true,
                newUI: false,
                newAPI: true,
            });
        });

        it('should return undefined for non-existent feature flag', async () => {
            const config = buildConfigObject(testConfig);

            // Test async get
            const asyncValue = await config.featureFlag.getAsync('nonExistentKey' as any);
            expect(asyncValue).toBeUndefined();

            // Test sync get
            const syncValue = config.featureFlag.getSync('nonExistentKey' as any);
            expect(syncValue).toBeUndefined();
        });
    });

    describe('type safety', () => {
        it('should enforce correct types for public config keys', () => {
            const config = buildConfigObject(testConfig);

            // @ts-expect-error - should not allow non-public keys
            config.publicConfig.getSync('apiKeys');

            // @ts-expect-error - should not allow non-public keys
            config.publicConfig.getSync('dbCredentials');

            // @ts-expect-error - should not allow non-public keys
            config.publicConfig.getSync('jwt');

            // These should be valid
            config.publicConfig.getSync('api');
            config.publicConfig.getSync('database');
            config.publicConfig.getSync('logging');
            config.publicConfig.getSync('featureFlags');
        });

        it('should enforce correct types for secret config keys', () => {
            const config = buildConfigObject(testConfig);

            // @ts-expect-error - should not allow non-secret keys
            config.secretConfig.getSync('api');

            // @ts-expect-error - should not allow non-secret keys
            config.secretConfig.getSync('database');

            // @ts-expect-error - should not allow non-secret keys
            config.secretConfig.getSync('logging');

            // @ts-expect-error - should not allow non-secret keys
            config.secretConfig.getSync('featureFlags');

            // These should be valid
            config.secretConfig.getSync('apiKeys');
            config.secretConfig.getSync('dbCredentials');
            config.secretConfig.getSync('jwt');
        });

        it('should enforce correct types for feature flag keys', () => {
            const config = buildConfigObject(testConfig);

            // @ts-expect-error - should not allow non-feature flag keys
            config.featureFlag.getSync('api');

            // @ts-expect-error - should not allow non-feature flag keys
            config.featureFlag.getSync('database');

            // @ts-expect-error - should not allow non-feature flag keys
            config.featureFlag.getSync('logging');

            // @ts-expect-error - should not allow non-feature flag keys
            config.featureFlag.getSync('apiKeys');

            // These should be valid
            config.featureFlag.getSync('experimental');
            config.featureFlag.getSync('beta');
            config.featureFlag.getSync('maintenance');
        });
    });
});
