import path from 'path';
import { PublicConfigKey } from '@/config/PublicConfigKey';
import buildConfigObject from '@/platform/server';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import config from './smooai-config/config';

describe('Server Config Integration Tests', () => {
    const originalConfigDir = process.env.SMOOAI_ENV_CONFIG_DIR;
    const originalConfigEnv = process.env.SMOOAI_CONFIG_ENV;

    beforeAll(() => {
        // Set the config directory to point to the integration test config directory
        process.env.SMOOAI_ENV_CONFIG_DIR = path.resolve(__dirname, 'smooai-config');
        // Set environment to 'test' so it only loads default.ts (since test.ts doesn't exist)
        process.env.SMOOAI_CONFIG_ENV = 'test';
    });

    afterAll(() => {
        // Restore original environment
        if (originalConfigDir) {
            process.env.SMOOAI_ENV_CONFIG_DIR = originalConfigDir;
        } else {
            delete process.env.SMOOAI_ENV_CONFIG_DIR;
        }
        if (originalConfigEnv) {
            process.env.SMOOAI_CONFIG_ENV = originalConfigEnv;
        } else {
            delete process.env.SMOOAI_CONFIG_ENV;
        }
    });

    const serverConfig = buildConfigObject(config);

    beforeEach(() => {
        // Clear any caches that might be persisting between tests
        // This helps ensure a clean state for each test
    });

    describe('Standard Public Config', () => {
        it('should retrieve standard environment config', async () => {
            const env = await serverConfig.publicConfig.getAsync(PublicConfigKey.ENV);
            expect(env).toBeDefined();
        });

        it('should retrieve standard cloud provider config', async () => {
            const cloudProvider = await serverConfig.publicConfig.getAsync(PublicConfigKey.CLOUD_PROVIDER);
            expect(cloudProvider).toBeDefined();
        });

        it('should retrieve standard region config', async () => {
            const region = await serverConfig.publicConfig.getAsync(PublicConfigKey.REGION);
            expect(region).toBeDefined();
        });

        it('should retrieve standard is local config', async () => {
            const isLocal = await serverConfig.publicConfig.getAsync(PublicConfigKey.IS_LOCAL);
            expect(typeof isLocal).toBe('boolean');
        });
    });

    describe('Public Config', () => {
        it('should retrieve basic string config', async () => {
            const apiUrl = await serverConfig.publicConfig.getAsync('apiUrl');
            expect(apiUrl).toBe('http://localhost:3000');
        });

        it('should retrieve basic number config', async () => {
            const maxRetries = await serverConfig.publicConfig.getAsync('maxRetries');
            expect(maxRetries).toBe(3);
        });

        it('should retrieve basic boolean config', async () => {
            const enableDebug = await serverConfig.publicConfig.getAsync('enableDebug');
            expect(enableDebug).toBe(true);
        });

        it('should retrieve structured database config', async () => {
            const database = await serverConfig.publicConfig.getAsync('database');
            expect(database).toEqual({
                host: 'localhost',
                port: 5432,
                ssl: false,
                connectionTimeout: 5000,
                poolSize: 10,
            });
        });

        it('should retrieve structured features config', async () => {
            const features = await serverConfig.publicConfig.getAsync('features');
            expect(features).toEqual({
                rateLimiting: {
                    enabled: true,
                    requestsPerMinute: 60,
                    burstSize: 10,
                },
                caching: {
                    enabled: true,
                    ttl: 3600,
                    maxSize: 1000,
                },
            });
        });

        it('should handle invalid public config key', async () => {
            // @ts-expect-error Testing invalid key
            const result = await serverConfig.publicConfig.getAsync('nonexistentKey');
            expect(result).toBeUndefined();
        });
    });

    describe('Secret Config', () => {
        it('should retrieve basic secret string config', async () => {
            const apiKey = await serverConfig.secretConfig.getAsync('apiKey');
            expect(apiKey).toBe('dev-api-key');
        });

        it('should retrieve structured credentials config', async () => {
            const credentials = await serverConfig.secretConfig.getAsync('credentials');
            expect(credentials).toEqual({
                username: 'admin',
                password: 'admin123',
                mfaEnabled: false,
                allowedIps: ['127.0.0.1'],
            });
        });

        it('should retrieve structured encryption config', async () => {
            const encryption = await serverConfig.secretConfig.getAsync('encryption');
            expect(encryption).toEqual({
                algorithm: 'aes-256-gcm',
                keyRotationDays: 30,
                backupEnabled: true,
            });
        });

        it('should handle invalid secret config key', async () => {
            // @ts-expect-error Testing invalid key
            const result = await serverConfig.secretConfig.getAsync('nonexistentKey');
            expect(result).toBeUndefined();
        });
    });

    describe('Feature Flags', () => {
        it('should retrieve basic feature flags', async () => {
            const enableNewUI = await serverConfig.featureFlag.getAsync('enableNewUI');
            const betaFeatures = await serverConfig.featureFlag.getAsync('betaFeatures');
            expect(enableNewUI).toBe(false);
            expect(betaFeatures).toBe(false);
        });

        it('should retrieve structured experimental features config', async () => {
            const experimentalFeatures = await serverConfig.featureFlag.getAsync('experimentalFeatures');
            expect(experimentalFeatures).toEqual({
                aiAssist: false,
                darkMode: false,
                performanceOptimizations: false,
                rolloutPercentage: 0,
            });
        });

        it('should retrieve structured A/B testing config', async () => {
            const abTesting = await serverConfig.featureFlag.getAsync('abTesting');
            expect(abTesting).toEqual({
                enabled: false,
                testGroups: [
                    {
                        name: 'control',
                        percentage: 50,
                        features: [],
                    },
                    {
                        name: 'experimental',
                        percentage: 50,
                        features: [],
                    },
                ],
            });
        });

        it('should handle invalid feature flag key', async () => {
            // @ts-expect-error Testing invalid key
            const result = await serverConfig.featureFlag.getAsync('nonexistentKey');
            expect(result).toBeUndefined();
        });
    });

    describe('Sync Methods', () => {
        // These tests are skipped because synckit worker processes don't inherit
        // the environment variables set in the test, causing config directory
        // lookup failures. This is a known limitation for integration testing.

        it('should retrieve public config synchronously', () => {
            const apiUrl = serverConfig.publicConfig.getSync('apiUrl');
            expect(apiUrl).toBe('http://localhost:3000');
        });

        it('should retrieve secret config synchronously', () => {
            const apiKey = serverConfig.secretConfig.getSync('apiKey');
            expect(apiKey).toBe('dev-api-key');
        });

        it('should retrieve feature flag synchronously', () => {
            const enableNewUI = serverConfig.featureFlag.getSync('enableNewUI');
            expect(enableNewUI).toBe(false);
        });

        it('should handle invalid keys in sync methods', () => {
            // @ts-expect-error Testing invalid key
            const publicResult = serverConfig.publicConfig.getSync('nonexistentKey');
            // @ts-expect-error Testing invalid key
            const secretResult = serverConfig.secretConfig.getSync('nonexistentKey');
            // @ts-expect-error Testing invalid key
            const featureResult = serverConfig.featureFlag.getSync('nonexistentKey');

            expect(publicResult).toBeUndefined();
            expect(secretResult).toBeUndefined();
            expect(featureResult).toBeUndefined();
        });
    });

    describe('Type Validation', () => {
        it('should validate database port range', async () => {
            const database = await serverConfig.publicConfig.getAsync('database');
            expect(database).toBeDefined();
            if (database) {
                expect(database.port).toBeGreaterThanOrEqual(1);
                expect(database.port).toBeLessThanOrEqual(65535);
            }
        });

        it('should validate connection timeout range', async () => {
            const database = await serverConfig.publicConfig.getAsync('database');
            expect(database).toBeDefined();
            if (database) {
                expect(database.connectionTimeout).toBeGreaterThanOrEqual(1000);
                expect(database.connectionTimeout).toBeLessThanOrEqual(30000);
            }
        });

        it('should validate pool size range', async () => {
            const database = await serverConfig.publicConfig.getAsync('database');
            expect(database).toBeDefined();
            if (database) {
                expect(database.poolSize).toBeGreaterThanOrEqual(1);
                expect(database.poolSize).toBeLessThanOrEqual(100);
            }
        });

        it('should validate encryption algorithm', async () => {
            const encryption = await serverConfig.secretConfig.getAsync('encryption');
            expect(encryption).toBeDefined();
            if (encryption) {
                expect(['aes-256-gcm', 'chacha20-poly1305']).toContain(encryption.algorithm);
            }
        });

        it('should validate key rotation days range', async () => {
            const encryption = await serverConfig.secretConfig.getAsync('encryption');
            expect(encryption).toBeDefined();
            if (encryption) {
                expect(encryption.keyRotationDays).toBeGreaterThanOrEqual(1);
                expect(encryption.keyRotationDays).toBeLessThanOrEqual(365);
            }
        });

        it('should validate rollout percentage range', async () => {
            const experimentalFeatures = await serverConfig.featureFlag.getAsync('experimentalFeatures');
            expect(experimentalFeatures).toBeDefined();
            if (experimentalFeatures) {
                expect(experimentalFeatures.rolloutPercentage).toBeGreaterThanOrEqual(0);
                expect(experimentalFeatures.rolloutPercentage).toBeLessThanOrEqual(100);
            }
        });
    });
});
