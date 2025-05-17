import { describe, expect, it } from 'vitest';
import z from 'zod';
import { defineConfig, InferConfigTypes, StringSchema } from './config';

describe('defineConfig', () => {
    it('should define config', () => {
        const config = defineConfig(
            {
                myPublicApiKey: StringSchema,
                myPublicStructuredConfig: z.object({
                    key: z.string(),
                    value: z.string(),
                }),
            },
            {
                mySecretApiKey: StringSchema,
                mySecretStructuredConfig: z.object({
                    key: z.string(),
                    value: z.string(),
                }),
            },
            {
                enableNewUI: StringSchema,
                betaFeatures: z.object({
                    enabled: z.boolean(),
                    description: z.string(),
                }),
            },
        );

        const { PublicConfigKeys, SecretConfigKeys, FeatureFlagKeys, parseConfig } = config;

        type configTypes = InferConfigTypes<typeof config>;
        type ConfigType = configTypes['ConfigType'];

        const testConfig = {
            myPublicApiKey: 'test-public-key',
            myPublicStructuredConfig: {
                key: 'test-key',
                value: 'test-value',
            },
            mySecretApiKey: 'test-secret-key',
            mySecretStructuredConfig: {
                key: 'test-secret-key',
                value: 'test-secret-value',
            },
            enableNewUI: 'true',
            betaFeatures: {
                enabled: true,
                description: 'Beta features are enabled',
            },
        };

        const blah: ConfigType = {
            [PublicConfigKeys.ENV]: 'myPublicApiKey',
            [PublicConfigKeys.MY_PUBLIC_STRUCTURED_CONFIG]: {
                key: 'myPublicApiKey',
                value: 'myPublicApiKey',
            },
            [SecretConfigKeys.MY_SECRET_API_KEY]: 'mySecretApiKey',
            [SecretConfigKeys.MY_SECRET_STRUCTURED_CONFIG]: {
                key: 'mySecretApiKey',
                value: 'mySecretApiKey',
            },
            [FeatureFlagKeys.ENABLE_NEW_U_I]: 'true',
            [FeatureFlagKeys.BETA_FEATURES]: {
                enabled: true,
                description: 'Beta features are enabled',
            },
        };

        const publicConfigKeys = Object.keys(PublicConfigKeys);
        const secretConfigKeys = Object.keys(SecretConfigKeys);
        const featureFlagKeys = Object.keys(FeatureFlagKeys);

        expect(publicConfigKeys).toEqual(['MY_PUBLIC_API_KEY', 'MY_PUBLIC_STRUCTURED_CONFIG', 'ENV', 'IS_LOCAL', 'REGION', 'CLOUD_PROVIDER']);
        expect(secretConfigKeys).toEqual(['MY_SECRET_API_KEY', 'MY_SECRET_STRUCTURED_CONFIG']);
        expect(featureFlagKeys).toEqual(['ENABLE_NEW_U_I', 'BETA_FEATURES']);

        const parsedConfig = parseConfig(testConfig);
        expect(parsedConfig).toBeDefined();
        if (parsedConfig) {
            expect(parsedConfig.myPublicApiKey).toBe('test-public-key');
            expect(parsedConfig.mySecretApiKey).toBe('test-secret-key');
            expect(parsedConfig.enableNewUI).toBe('true');
            expect(parsedConfig.betaFeatures.enabled).toBe(true);
        }
    });

    describe('key name transformations', () => {
        it('should handle basic camelCase to SNAKE_CASE conversion', () => {
            const config = defineConfig(
                {
                    simpleKey: StringSchema,
                    multiWordKey: StringSchema,
                    already_snake_case: StringSchema,
                    ALREADY_UPPER_SNAKE: StringSchema,
                    mixedCase_WithUnderscore: StringSchema,
                },
                {},
                {}
            );

            const { PublicConfigKeys } = config;
            expect(Object.keys(PublicConfigKeys)).toEqual([
                'SIMPLE_KEY',
                'MULTI_WORD_KEY',
                'ALREADY_SNAKE_CASE',
                'ALREADY_UPPER_SNAKE',
                'MIXED_CASE_WITH_UNDERSCORE',
                'ENV',
                'IS_LOCAL',
                'REGION',
                'CLOUD_PROVIDER'
            ]);
        });

        it('should handle special characters and spaces in keys', () => {
            const config = defineConfig(
                {
                    'key with spaces': StringSchema,
                    'key-with-hyphens': StringSchema,
                    'key.with.dots': StringSchema,
                    'key@with@special': StringSchema,
                },
                {},
                {}
            );

            const { PublicConfigKeys } = config;
            expect(Object.keys(PublicConfigKeys)).toEqual([
                'KEY_WITH_SPACES',
                'KEY_WITH_HYPHENS',
                'KEY_WITH_DOTS',
                'KEY_WITH_SPECIAL',
                'ENV',
                'IS_LOCAL',
                'REGION',
                'CLOUD_PROVIDER'
            ]);
        });
    });

    describe('config parsing', () => {
        it('should parse basic string configs', () => {
            const config = defineConfig(
                {
                    apiKey: StringSchema,
                    endpoint: StringSchema,
                },
                {},
                {}
            );

            const testConfig = {
                apiKey: 'test-key',
                endpoint: 'https://api.example.com',
            };

            const result = config.parseConfig(testConfig);
            expect(result).toEqual(testConfig);
        });

        it('should parse structured configs', () => {
            const config = defineConfig(
                {
                    apiConfig: z.object({
                        key: z.string(),
                        url: z.string().url(),
                        timeout: z.number(),
                    }),
                },
                {},
                {}
            );

            const testConfig = {
                apiConfig: {
                    key: 'test-key',
                    url: 'https://api.example.com',
                    timeout: 5000,
                },
            };

            const result = config.parseConfig(testConfig);
            expect(result).toEqual(testConfig);
        });

        it('should handle deferred functions in configs', () => {
            const config = defineConfig(
                {
                    baseUrl: StringSchema,
                    apiEndpoint: StringSchema,
                },
                {},
                {}
            );

            const testConfig = {
                baseUrl: 'https://api.example.com',
                apiEndpoint: (config: { baseUrl: string }) => `${config.baseUrl}/v1`,
            };

            const result = config.parseConfig(testConfig);
            expect(result).toBeDefined();
            if (result) {
                expect(result.baseUrl).toBe('https://api.example.com');
                expect(typeof result.apiEndpoint).toBe('function');
            }
        });

        it('should validate required fields in structured configs', () => {
            const config = defineConfig(
                {
                    userConfig: z.object({
                        name: z.string(),
                        age: z.number(),
                        email: z.string().email(),
                    }),
                },
                {},
                {}
            );

            const invalidConfig = {
                userConfig: {
                    name: 'John',
                    age: 30,
                    email: 'invalid-email',
                },
            };

            expect(() => config.parseConfig(invalidConfig)).toThrow();
        });

        it('should handle nested structured configs', () => {
            const config = defineConfig(
                {
                    appConfig: z.object({
                        database: z.object({
                            host: z.string(),
                            port: z.number(),
                            credentials: z.object({
                                username: z.string(),
                                password: z.string(),
                            }),
                        }),
                    }),
                },
                {},
                {}
            );

            const testConfig = {
                appConfig: {
                    database: {
                        host: 'localhost',
                        port: 5432,
                        credentials: {
                            username: 'admin',
                            password: 'secret',
                        },
                    },
                },
            };

            const result = config.parseConfig(testConfig);
            expect(result).toEqual(testConfig);
        });
    });

    describe('type inference', () => {
        it('should correctly infer types from config definition', () => {
            const config = defineConfig(
                {
                    apiKey: StringSchema,
                    settings: z.object({
                        enabled: z.boolean(),
                        timeout: z.number(),
                    }),
                },
                {
                    secretKey: StringSchema,
                },
                {
                    featureFlag: z.boolean(),
                }
            );

            type ConfigTypes = InferConfigTypes<typeof config>;
            type ConfigType = ConfigTypes['ConfigType'];

            // This should compile without errors
            const validConfig: ConfigType = {
                [config.PublicConfigKeys.API_KEY]: 'test-key',
                [config.PublicConfigKeys.SETTINGS]: {
                    enabled: true,
                    timeout: 1000,
                },
                [config.SecretConfigKeys.SECRET_KEY]: 'secret-value',
                [config.FeatureFlagKeys.FEATURE_FLAG]: true,
            };

            expect(validConfig).toBeDefined();
        });
    });
});
