/**
 * Integration test suite 2: Full pipeline integration tests
 *
 * Tests the complete config loading flow with real config files and real
 * process.env variables — no mocking of core modules.
 *
 * Uses dynamic imports with vi.resetModules() to clear module-level caches
 * between test groups, ensuring each group gets a fresh config state.
 * Uses server.async (async-only) to avoid synckit worker thread issues
 * that require a built dist/ directory.
 */
import path from 'path';
import { PublicConfigKey } from '@/config/PublicConfigKey';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import config from './smooai-config/config';

const CONFIG_DIR = path.resolve(__dirname, 'smooai-config');

/** Save and set env vars, returning a restore function. */
function withEnv(vars: Record<string, string | undefined>): () => void {
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(vars)) {
        saved[key] = process.env[key];
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
    return () => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    };
}

/** Dynamic import of buildConfigObjectAsync with fresh module state. */
async function freshBuildConfigObject() {
    vi.resetModules();
    const mod = await import('@/platform/server/server.async');
    return mod.default(config);
}

describe('Full Pipeline Integration Tests', () => {
    describe('Default config loading (no env overlay)', () => {
        let restore: () => void;

        beforeAll(() => {
            restore = withEnv({
                SMOOAI_ENV_CONFIG_DIR: CONFIG_DIR,
                SMOOAI_CONFIG_ENV: 'test', // nonexistent env file → only default.ts loads
                IS_LOCAL: undefined,
                AWS_REGION: undefined,
                AWS_DEFAULT_REGION: undefined,
                AZURE_REGION: undefined,
                AZURE_LOCATION: undefined,
                GOOGLE_CLOUD_REGION: undefined,
                CLOUDSDK_COMPUTE_REGION: undefined,
                SMOOAI_CONFIG_CLOUD_PROVIDER: undefined,
                SMOOAI_CONFIG_CLOUD_REGION: undefined,
            });
        });

        afterAll(() => restore());

        it('loads all config tiers from default.ts', async () => {
            const serverConfig = await freshBuildConfigObject();

            // Public config
            const apiUrl = await serverConfig.getPublicConfig('apiUrl');
            expect(apiUrl).toBe('http://localhost:3000');

            const maxRetries = await serverConfig.getPublicConfig('maxRetries');
            expect(maxRetries).toBe(3);

            const enableDebug = await serverConfig.getPublicConfig('enableDebug');
            expect(enableDebug).toBe(true);

            const appName = await serverConfig.getPublicConfig('appName');
            expect(appName).toBe('default-app');

            const database = await serverConfig.getPublicConfig('database');
            expect(database).toEqual({
                host: 'localhost',
                port: 5432,
                ssl: false,
            });

            // Secret config
            const apiKey = await serverConfig.getSecretConfig('apiKey');
            expect(apiKey).toBe('default-api-key');

            const dbPassword = await serverConfig.getSecretConfig('dbPassword');
            expect(dbPassword).toBe('default-db-pass');

            // Feature flags
            const enableNewUI = await serverConfig.getFeatureFlag('enableNewUI');
            expect(enableNewUI).toBe(false);

            const enableBeta = await serverConfig.getFeatureFlag('enableBeta');
            expect(enableBeta).toBe(false);

            const maintenanceMode = await serverConfig.getFeatureFlag('maintenanceMode');
            expect(maintenanceMode).toBe(false);
        });

        it('sets standard built-in config', async () => {
            const serverConfig = await freshBuildConfigObject();

            const env = await serverConfig.getPublicConfig(PublicConfigKey.ENV as any);
            expect(env).toBe('test');

            const isLocal = await serverConfig.getPublicConfig(PublicConfigKey.IS_LOCAL as any);
            expect(isLocal).toBe(false);

            const provider = await serverConfig.getPublicConfig(PublicConfigKey.CLOUD_PROVIDER as any);
            expect(provider).toBe('unknown');

            const region = await serverConfig.getPublicConfig(PublicConfigKey.REGION as any);
            expect(region).toBe('unknown');
        });

        it('returns undefined for non-existent keys', async () => {
            const serverConfig = await freshBuildConfigObject();

            const result = await serverConfig.getPublicConfig('nonexistent' as any);
            expect(result).toBeUndefined();
        });
    });

    describe('Environment-specific file merging (development)', () => {
        let restore: () => void;

        beforeAll(() => {
            restore = withEnv({
                SMOOAI_ENV_CONFIG_DIR: CONFIG_DIR,
                SMOOAI_CONFIG_ENV: 'development',
                IS_LOCAL: undefined,
                AWS_REGION: undefined,
                AWS_DEFAULT_REGION: undefined,
                AZURE_REGION: undefined,
                AZURE_LOCATION: undefined,
                GOOGLE_CLOUD_REGION: undefined,
                CLOUDSDK_COMPUTE_REGION: undefined,
                SMOOAI_CONFIG_CLOUD_PROVIDER: undefined,
                SMOOAI_CONFIG_CLOUD_REGION: undefined,
            });
        });

        afterAll(() => restore());

        it('overrides values from development.ts, inherits rest from default.ts', async () => {
            const serverConfig = await freshBuildConfigObject();

            // Overridden in development.ts
            const apiUrl = await serverConfig.getPublicConfig('apiUrl');
            expect(apiUrl).toBe('http://dev-api.example.com');

            const appName = await serverConfig.getPublicConfig('appName');
            expect(appName).toBe('dev-app');

            const enableDebug = await serverConfig.getPublicConfig('enableDebug');
            expect(enableDebug).toBe(true);

            // Inherited from default.ts (not overridden)
            const maxRetries = await serverConfig.getPublicConfig('maxRetries');
            expect(maxRetries).toBe(3);

            const database = await serverConfig.getPublicConfig('database');
            expect(database).toEqual({
                host: 'localhost',
                port: 5432,
                ssl: false,
            });
        });

        it('overrides feature flags from development.ts', async () => {
            const serverConfig = await freshBuildConfigObject();

            const enableNewUI = await serverConfig.getFeatureFlag('enableNewUI');
            expect(enableNewUI).toBe(true);

            const enableBeta = await serverConfig.getFeatureFlag('enableBeta');
            expect(enableBeta).toBe(true);

            // Not overridden → default
            const maintenanceMode = await serverConfig.getFeatureFlag('maintenanceMode');
            expect(maintenanceMode).toBe(false);
        });

        it('inherits secrets from default.ts when development.ts does not override them', async () => {
            const serverConfig = await freshBuildConfigObject();

            const apiKey = await serverConfig.getSecretConfig('apiKey');
            expect(apiKey).toBe('default-api-key');

            const dbPassword = await serverConfig.getSecretConfig('dbPassword');
            expect(dbPassword).toBe('default-db-pass');
        });
    });

    describe('Production + provider + region merge chain', () => {
        let restore: () => void;

        beforeAll(() => {
            restore = withEnv({
                SMOOAI_ENV_CONFIG_DIR: CONFIG_DIR,
                SMOOAI_CONFIG_ENV: 'production',
                IS_LOCAL: undefined,
                AWS_REGION: 'us-east-1',
                AWS_DEFAULT_REGION: undefined,
                AZURE_REGION: undefined,
                AZURE_LOCATION: undefined,
                GOOGLE_CLOUD_REGION: undefined,
                CLOUDSDK_COMPUTE_REGION: undefined,
                SMOOAI_CONFIG_CLOUD_PROVIDER: undefined,
                SMOOAI_CONFIG_CLOUD_REGION: undefined,
            });
        });

        afterAll(() => restore());

        it('merges default → production → production.aws → production.aws.us-east-1', async () => {
            const serverConfig = await freshBuildConfigObject();

            // production.aws.ts overrides apiUrl from production.ts
            const apiUrl = await serverConfig.getPublicConfig('apiUrl');
            expect(apiUrl).toBe('https://aws-api.example.com');

            // production.ts sets maxRetries=5
            const maxRetries = await serverConfig.getPublicConfig('maxRetries');
            expect(maxRetries).toBe(5);

            // production.aws.us-east-1.ts overrides database.host via defer function
            const database = await serverConfig.getPublicConfig('database');
            expect(database).toBeDefined();
            expect(database!.host).toBe('us-east-1-db.example.com');
            // ssl comes from production.ts
            expect(database!.ssl).toBe(true);
            // port from default.ts
            expect(database!.port).toBe(5432);
        });

        it('applies production secrets', async () => {
            const serverConfig = await freshBuildConfigObject();

            const apiKey = await serverConfig.getSecretConfig('apiKey');
            expect(apiKey).toBe('prod-api-key-secret');

            const dbPassword = await serverConfig.getSecretConfig('dbPassword');
            expect(dbPassword).toBe('prod-db-pass-secret');

            const jwtSecret = await serverConfig.getSecretConfig('jwtSecret');
            expect(jwtSecret).toBe('prod-jwt-secret');
        });

        it('detects AWS cloud provider and region from env vars', async () => {
            const serverConfig = await freshBuildConfigObject();

            const provider = await serverConfig.getPublicConfig(PublicConfigKey.CLOUD_PROVIDER as any);
            expect(provider).toBe('aws');

            const region = await serverConfig.getPublicConfig(PublicConfigKey.REGION as any);
            expect(region).toBe('us-east-1');
        });

        it('sets enableDebug=false from production.ts override', async () => {
            const serverConfig = await freshBuildConfigObject();

            const enableDebug = await serverConfig.getPublicConfig('enableDebug');
            expect(enableDebug).toBe(false);
        });
    });

    describe('Tier isolation — TypeScript enforced, runtime uses flat config', () => {
        let restore: () => void;

        beforeAll(() => {
            restore = withEnv({
                SMOOAI_ENV_CONFIG_DIR: CONFIG_DIR,
                SMOOAI_CONFIG_ENV: 'test',
                IS_LOCAL: undefined,
                AWS_REGION: undefined,
                SMOOAI_CONFIG_CLOUD_PROVIDER: undefined,
                SMOOAI_CONFIG_CLOUD_REGION: undefined,
            });
        });

        afterAll(() => restore());

        it('TypeScript prevents cross-tier access at compile time', async () => {
            const serverConfig = await freshBuildConfigObject();

            // These would fail TypeScript compilation without `as any`:
            // @ts-expect-error - TS enforces tier isolation
            await serverConfig.getPublicConfig('apiKey');
            // @ts-expect-error - TS enforces tier isolation
            await serverConfig.getSecretConfig('apiUrl');
            // @ts-expect-error - TS enforces tier isolation
            await serverConfig.getPublicConfig('enableNewUI');
            // @ts-expect-error - TS enforces tier isolation
            await serverConfig.getFeatureFlag('apiUrl');
        });

        it('each getter retrieves only its designated tier keys correctly', async () => {
            const serverConfig = await freshBuildConfigObject();

            // Public tier
            const apiUrl = await serverConfig.getPublicConfig('apiUrl');
            expect(apiUrl).toBe('http://localhost:3000');

            // Secret tier
            const apiKey = await serverConfig.getSecretConfig('apiKey');
            expect(apiKey).toBe('default-api-key');

            // Feature flag tier
            const enableNewUI = await serverConfig.getFeatureFlag('enableNewUI');
            expect(enableNewUI).toBe(false);
        });

        it('non-existent keys return undefined', async () => {
            const serverConfig = await freshBuildConfigObject();

            const result = await serverConfig.getPublicConfig('totallyFakeKey' as any);
            expect(result).toBeUndefined();
        });
    });

    describe('Cloud region detection via env vars', () => {
        it('detects AWS provider from AWS_REGION', async () => {
            const restore = withEnv({
                SMOOAI_ENV_CONFIG_DIR: CONFIG_DIR,
                SMOOAI_CONFIG_ENV: 'test',
                AWS_REGION: 'eu-west-1',
                AWS_DEFAULT_REGION: undefined,
                AZURE_REGION: undefined,
                AZURE_LOCATION: undefined,
                GOOGLE_CLOUD_REGION: undefined,
                CLOUDSDK_COMPUTE_REGION: undefined,
                SMOOAI_CONFIG_CLOUD_PROVIDER: undefined,
                SMOOAI_CONFIG_CLOUD_REGION: undefined,
            });

            try {
                const serverConfig = await freshBuildConfigObject();
                const provider = await serverConfig.getPublicConfig(PublicConfigKey.CLOUD_PROVIDER as any);
                const region = await serverConfig.getPublicConfig(PublicConfigKey.REGION as any);
                expect(provider).toBe('aws');
                expect(region).toBe('eu-west-1');
            } finally {
                restore();
            }
        });

        it('detects custom provider from SMOOAI_CONFIG_CLOUD_PROVIDER', async () => {
            const restore = withEnv({
                SMOOAI_ENV_CONFIG_DIR: CONFIG_DIR,
                SMOOAI_CONFIG_ENV: 'test',
                AWS_REGION: undefined,
                AWS_DEFAULT_REGION: undefined,
                SMOOAI_CONFIG_CLOUD_PROVIDER: 'custom-cloud',
                SMOOAI_CONFIG_CLOUD_REGION: 'custom-region-1',
            });

            try {
                const serverConfig = await freshBuildConfigObject();
                const provider = await serverConfig.getPublicConfig(PublicConfigKey.CLOUD_PROVIDER as any);
                const region = await serverConfig.getPublicConfig(PublicConfigKey.REGION as any);
                expect(provider).toBe('custom-cloud');
                expect(region).toBe('custom-region-1');
            } finally {
                restore();
            }
        });

        it('falls back to unknown when no cloud env vars set', async () => {
            const restore = withEnv({
                SMOOAI_ENV_CONFIG_DIR: CONFIG_DIR,
                SMOOAI_CONFIG_ENV: 'test',
                AWS_REGION: undefined,
                AWS_DEFAULT_REGION: undefined,
                AZURE_REGION: undefined,
                AZURE_LOCATION: undefined,
                GOOGLE_CLOUD_REGION: undefined,
                CLOUDSDK_COMPUTE_REGION: undefined,
                SMOOAI_CONFIG_CLOUD_PROVIDER: undefined,
                SMOOAI_CONFIG_CLOUD_REGION: undefined,
            });

            try {
                const serverConfig = await freshBuildConfigObject();
                const provider = await serverConfig.getPublicConfig(PublicConfigKey.CLOUD_PROVIDER as any);
                const region = await serverConfig.getPublicConfig(PublicConfigKey.REGION as any);
                expect(provider).toBe('unknown');
                expect(region).toBe('unknown');
            } finally {
                restore();
            }
        });
    });

    describe('Consistent results across multiple calls', () => {
        let restore: () => void;

        beforeAll(() => {
            restore = withEnv({
                SMOOAI_ENV_CONFIG_DIR: CONFIG_DIR,
                SMOOAI_CONFIG_ENV: 'test',
                IS_LOCAL: undefined,
                AWS_REGION: undefined,
                SMOOAI_CONFIG_CLOUD_PROVIDER: undefined,
                SMOOAI_CONFIG_CLOUD_REGION: undefined,
            });
        });

        afterAll(() => restore());

        it('returns same value on repeated async calls', async () => {
            const serverConfig = await freshBuildConfigObject();

            const result1 = await serverConfig.getPublicConfig('apiUrl');
            const result2 = await serverConfig.getPublicConfig('apiUrl');
            const result3 = await serverConfig.getPublicConfig('apiUrl');
            expect(result1).toBe(result2);
            expect(result2).toBe(result3);
            expect(result1).toBe('http://localhost:3000');
        });

        it('returns same structured value on repeated calls', async () => {
            const serverConfig = await freshBuildConfigObject();

            const result1 = await serverConfig.getPublicConfig('database');
            const result2 = await serverConfig.getPublicConfig('database');
            expect(result1).toEqual(result2);
        });
    });
});
