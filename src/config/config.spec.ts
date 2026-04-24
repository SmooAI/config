/* eslint-disable @typescript-eslint/no-explicit-any -- ok */
import { describe, expect, it } from 'vitest';
import z from 'zod';
import { defineConfig, InferConfigTypes, StringSchema, NumberSchema, BooleanSchema, serializeConfigSchemaToJsonSchema } from './config';
import { generateZodSchemas, parseConfig } from './parseConfigSchema';

describe('defineConfig', () => {
    it('should define config', () => {
        const config = defineConfig({
            publicConfigSchema: {
                myPublicApiKey: StringSchema,
                myPublicStructuredConfig: z.object({
                    key: z.string(),
                    value: z.string(),
                }),
            },
            secretConfigSchema: {
                mySecretApiKey: StringSchema,
                mySecretStructuredConfig: z.object({
                    key: z.string(),
                    value: z.string(),
                }),
            },
            featureFlagSchema: {
                enableNewUI: StringSchema,
                betaFeatures: z.object({
                    enabled: z.boolean(),
                    description: z.string(),
                }),
            },
        });

        const { PublicConfigKeys, SecretConfigKeys, FeatureFlagKeys } = config;
        const { allConfigZodSchemaWithDeferFunctions } = generateZodSchemas(config);

        type configTypes = InferConfigTypes<typeof config>;
        type ConfigTypeInput = configTypes['ConfigTypeInput'];
        type ConfigType = configTypes['ConfigType'];

        const testConfig: ConfigTypeInput = {
            [PublicConfigKeys.MY_PUBLIC_API_KEY]: 'test-public-key',
            [PublicConfigKeys.MY_PUBLIC_STRUCTURED_CONFIG]: {
                key: 'myPublicApiKey',
                value: 'myPublicApiKey',
            },
            [SecretConfigKeys.MY_SECRET_API_KEY]: 'test-secret-key',
            [SecretConfigKeys.MY_SECRET_STRUCTURED_CONFIG]: {
                key: 'mySecretApiKey',
                value: 'mySecretApiKey',
            },
            [FeatureFlagKeys.ENABLE_NEW_UI]: 'true',
            [FeatureFlagKeys.BETA_FEATURES]: {
                enabled: true,
                description: 'Beta features are enabled',
            },
        };

        const publicConfigKeys = Object.keys(PublicConfigKeys);
        const secretConfigKeys = Object.keys(SecretConfigKeys);
        const featureFlagKeys = Object.keys(FeatureFlagKeys);

        const publicConfigValues = Object.values(PublicConfigKeys);
        const secretConfigValues = Object.values(SecretConfigKeys);
        const featureFlagValues = Object.values(FeatureFlagKeys);

        expect(publicConfigKeys).toEqual(
            expect.arrayContaining(['MY_PUBLIC_API_KEY', 'MY_PUBLIC_STRUCTURED_CONFIG', 'ENV', 'IS_LOCAL', 'REGION', 'CLOUD_PROVIDER']),
        );
        expect(publicConfigValues).toEqual(
            expect.arrayContaining([
                PublicConfigKeys.MY_PUBLIC_API_KEY,
                PublicConfigKeys.MY_PUBLIC_STRUCTURED_CONFIG,
                PublicConfigKeys.ENV,
                PublicConfigKeys.IS_LOCAL,
                PublicConfigKeys.REGION,
                PublicConfigKeys.CLOUD_PROVIDER,
            ]),
        );
        expect(publicConfigValues).toEqual(
            expect.arrayContaining(['myPublicApiKey', 'myPublicStructuredConfig', 'ENV', 'IS_LOCAL', 'REGION', 'CLOUD_PROVIDER']),
        );

        expect(secretConfigKeys).toEqual(expect.arrayContaining(['MY_SECRET_API_KEY', 'MY_SECRET_STRUCTURED_CONFIG']));
        expect(secretConfigValues).toEqual(expect.arrayContaining([SecretConfigKeys.MY_SECRET_API_KEY, SecretConfigKeys.MY_SECRET_STRUCTURED_CONFIG]));
        expect(secretConfigValues).toEqual(expect.arrayContaining(['mySecretApiKey', 'mySecretStructuredConfig']));

        expect(featureFlagKeys).toEqual(expect.arrayContaining(['ENABLE_NEW_UI', 'BETA_FEATURES']));
        expect(featureFlagValues).toEqual(expect.arrayContaining([FeatureFlagKeys.ENABLE_NEW_UI, FeatureFlagKeys.BETA_FEATURES]));
        expect(featureFlagValues).toEqual(expect.arrayContaining(['enableNewUI', 'betaFeatures']));

        const parsedConfig = parseConfig(allConfigZodSchemaWithDeferFunctions, testConfig);
        expect(parsedConfig).toBeDefined();
        if (parsedConfig) {
            expect(parsedConfig.myPublicApiKey).toBe('test-public-key');
            expect(parsedConfig.mySecretApiKey).toBe('test-secret-key');
            expect(parsedConfig.enableNewUI).toBe('true');
            expect(parsedConfig.betaFeatures).toBeDefined();
            expect((parsedConfig.betaFeatures as any).enabled).toBe(true);
        }
    });

    it('should handle edge cases in key conversion to upper snake case', () => {
        const config = defineConfig({
            publicConfigSchema: {
                myAPIKey: StringSchema,
                myAPIKeyV2: StringSchema,
                myAPIKeyV2Beta: StringSchema,
                myAPIKeyV2BetaTest: StringSchema,
                myAPIKeyV2BetaTestProd: StringSchema,
                myAPIKeyV2BetaTestProdStaging: StringSchema,
                myAPIKeyV2BetaTestProdStagingDev: StringSchema,
                myAPIKeyV2BetaTestProdStagingDevLocal: StringSchema,
                myAPIKeyV2BetaTestProdStagingDevLocalTest: StringSchema,
                myAPIKeyV2BetaTestProdStagingDevLocalTestProd: StringSchema,
            },
        });

        const { PublicConfigKeys } = config;
        const publicConfigKeys = Object.keys(PublicConfigKeys).filter((key) => !['ENV', 'CLOUD_PROVIDER', 'REGION', 'IS_LOCAL'].includes(key));

        expect(publicConfigKeys).toEqual([
            'MY_API_KEY',
            'MY_API_KEY_V2',
            'MY_API_KEY_V2_BETA',
            'MY_API_KEY_V2_BETA_TEST',
            'MY_API_KEY_V2_BETA_TEST_PROD',
            'MY_API_KEY_V2_BETA_TEST_PROD_STAGING',
            'MY_API_KEY_V2_BETA_TEST_PROD_STAGING_DEV',
            'MY_API_KEY_V2_BETA_TEST_PROD_STAGING_DEV_LOCAL',
            'MY_API_KEY_V2_BETA_TEST_PROD_STAGING_DEV_LOCAL_TEST',
            'MY_API_KEY_V2_BETA_TEST_PROD_STAGING_DEV_LOCAL_TEST_PROD',
        ]);
    });

    it('should handle computed config values using functions', () => {
        const config = defineConfig({
            publicConfigSchema: {
                baseUrl: StringSchema,
                apiVersion: StringSchema,
                fullApiUrl: StringSchema,
                maxRetries: NumberSchema,
                retryDelay: NumberSchema,
                totalRetryTime: NumberSchema,
            },
            featureFlagSchema: {
                enableFeature: BooleanSchema,
                featureConfig: z.object({
                    enabled: z.boolean(),
                    timeout: z.number(),
                }),
            },
        });

        const { PublicConfigKeys, FeatureFlagKeys } = config;
        const { allConfigZodSchemaWithDeferFunctions } = generateZodSchemas(config);

        const testConfig = {
            [PublicConfigKeys.BASE_URL]: 'https://api.example.com',
            [PublicConfigKeys.API_VERSION]: 'v1',
            [PublicConfigKeys.FULL_API_URL]: (config: any) => `${config.baseUrl}/${config.apiVersion}`,
            [PublicConfigKeys.MAX_RETRIES]: 3,
            [PublicConfigKeys.RETRY_DELAY]: 1000,
            [PublicConfigKeys.TOTAL_RETRY_TIME]: (config: any) => config.maxRetries * config.retryDelay,
            [FeatureFlagKeys.ENABLE_FEATURE]: true,
            [FeatureFlagKeys.FEATURE_CONFIG]: (config: any) => ({
                enabled: config.enableFeature,
                timeout: config.maxRetries * 1000,
            }),
        };

        const parsedConfig = parseConfig(allConfigZodSchemaWithDeferFunctions, testConfig);
        expect(parsedConfig).toBeDefined();
        if (parsedConfig) {
            expect(parsedConfig.baseUrl).toBe('https://api.example.com');
            expect(parsedConfig.apiVersion).toBe('v1');
            expect(typeof parsedConfig.fullApiUrl).toBe('function');
            expect(parsedConfig.maxRetries).toBe(3);
            expect(parsedConfig.retryDelay).toBe(1000);
            expect(typeof parsedConfig.totalRetryTime).toBe('function');
            expect(parsedConfig.enableFeature).toBe(true);
            expect(typeof parsedConfig.featureConfig).toBe('function');
        }
    });

    it('should handle complex nested computed values', () => {
        const config = defineConfig({
            publicConfigSchema: {
                database: z.object({
                    host: z.string(),
                    port: z.number(),
                    credentials: z.object({
                        username: z.string(),
                        password: z.string(),
                    }),
                }),
                connectionString: StringSchema,
            },
        });

        const { PublicConfigKeys } = config;
        const { allConfigZodSchemaWithDeferFunctions } = generateZodSchemas(config);

        const testConfig = {
            [PublicConfigKeys.DATABASE]: {
                host: 'localhost',
                port: 5432,
                credentials: {
                    username: 'admin',
                    password: 'secret',
                },
            },
            [PublicConfigKeys.CONNECTION_STRING]: (config: any) =>
                `postgresql://${config.database.credentials.username}:${config.database.credentials.password}@${config.database.host}:${config.database.port}`,
        };

        const parsedConfig = parseConfig(allConfigZodSchemaWithDeferFunctions, testConfig);
        expect(parsedConfig).toBeDefined();
        if (parsedConfig) {
            expect(parsedConfig.database).toEqual({
                host: 'localhost',
                port: 5432,
                credentials: {
                    username: 'admin',
                    password: 'secret',
                },
            });
            expect(typeof parsedConfig.connectionString).toBe('function');
        }
    });

    it('should handle mixed type configurations with computed values', () => {
        const config = defineConfig({
            publicConfigSchema: {
                isProduction: BooleanSchema,
                environment: StringSchema,
                logLevel: StringSchema,
            },
            secretConfigSchema: {
                apiKey: StringSchema,
                jwtSecret: StringSchema,
            },
            featureFlagSchema: {
                enableLogging: BooleanSchema,
                loggingConfig: z.object({
                    level: z.string(),
                    format: z.string(),
                }),
            },
        });

        const { PublicConfigKeys, SecretConfigKeys, FeatureFlagKeys } = config;
        const { allConfigZodSchemaWithDeferFunctions } = generateZodSchemas(config);

        const testConfig = {
            [PublicConfigKeys.IS_PRODUCTION]: true,
            [PublicConfigKeys.ENVIRONMENT]: (config: any) => (config.isProduction ? 'prod' : 'dev'),
            [PublicConfigKeys.LOG_LEVEL]: (config: any) => (config.isProduction ? 'error' : 'debug'),
            [SecretConfigKeys.API_KEY]: 'secret-key',
            [SecretConfigKeys.JWT_SECRET]: 'jwt-secret',
            [FeatureFlagKeys.ENABLE_LOGGING]: true,
            [FeatureFlagKeys.LOGGING_CONFIG]: (config: any) => ({
                level: config.logLevel,
                format: config.isProduction ? 'json' : 'pretty',
            }),
        };

        const parsedConfig = parseConfig(allConfigZodSchemaWithDeferFunctions, testConfig);
        expect(parsedConfig).toBeDefined();
        if (parsedConfig) {
            expect(parsedConfig.isProduction).toBe(true);
            expect(typeof parsedConfig.environment).toBe('function');
            expect(typeof parsedConfig.logLevel).toBe('function');
            expect(parsedConfig.apiKey).toBe('secret-key');
            expect(parsedConfig.jwtSecret).toBe('jwt-secret');
            expect(parsedConfig.enableLogging).toBe(true);
            expect(typeof parsedConfig.loggingConfig).toBe('function');
        }
    });
});

describe('serializeConfigSchemaToJsonSchema (SMOODEV-671 tiered wire format)', () => {
    it('wraps all three tiers under their canonical keys', () => {
        const jsonSchema = serializeConfigSchemaToJsonSchema({
            publicConfigSchema: { apiUrl: StringSchema, debugMode: BooleanSchema, maxRetries: NumberSchema },
            secretConfigSchema: { apiKey: StringSchema },
            featureFlagSchema: { enableNewUI: BooleanSchema },
        });

        expect(jsonSchema).toEqual({
            type: 'object',
            properties: {
                publicConfigSchema: {
                    type: 'object',
                    properties: {
                        apiUrl: { type: 'string' },
                        debugMode: { type: 'boolean' },
                        maxRetries: { type: 'number' },
                    },
                },
                secretConfigSchema: {
                    type: 'object',
                    properties: {
                        apiKey: { type: 'string' },
                    },
                },
                featureFlagSchema: {
                    type: 'object',
                    properties: {
                        enableNewUI: { type: 'boolean' },
                    },
                },
            },
        });
    });

    it('emits an empty tier node when a schema is missing', () => {
        const jsonSchema = serializeConfigSchemaToJsonSchema({
            publicConfigSchema: { apiUrl: StringSchema },
        }) as any;

        expect(jsonSchema.properties.publicConfigSchema.properties).toEqual({ apiUrl: { type: 'string' } });
        expect(jsonSchema.properties.secretConfigSchema).toEqual({ type: 'object', properties: {} });
        expect(jsonSchema.properties.featureFlagSchema).toEqual({ type: 'object', properties: {} });
    });

    it('nests real JSON Schema for zod standard-schema fields', () => {
        const jsonSchema = serializeConfigSchemaToJsonSchema({
            publicConfigSchema: {
                database: z.object({
                    host: z.string(),
                    port: z.number(),
                }),
            },
        }) as any;

        const dbNode = jsonSchema.properties.publicConfigSchema.properties.database;
        expect(dbNode.type).toBe('object');
        expect(dbNode.properties.host).toMatchObject({ type: 'string' });
        expect(dbNode.properties.port).toMatchObject({ type: 'number' });
    });
});

describe('defineConfig exposes serializedAllConfigSchemaJsonSchema (SMOODEV-671)', () => {
    it('attaches the tiered JSON Schema alongside the flat serialization', () => {
        const config = defineConfig({
            publicConfigSchema: { apiUrl: StringSchema },
            secretConfigSchema: { apiKey: StringSchema },
            featureFlagSchema: { enableNewUI: BooleanSchema },
        });

        // Flat internal form preserved for local runtime / source generator.
        expect(config.serializedAllConfigSchema).toMatchObject({
            apiUrl: 'stringSchema',
            apiKey: 'stringSchema',
            enableNewUI: 'booleanSchema',
        });

        // Tiered form shipped to the server for the /apps/config UI.
        const wire = (config as any).serializedAllConfigSchemaJsonSchema;
        expect(wire).toBeDefined();
        expect(wire.type).toBe('object');
        expect(wire.properties.publicConfigSchema.properties.apiUrl).toEqual({ type: 'string' });
        expect(wire.properties.secretConfigSchema.properties.apiKey).toEqual({ type: 'string' });
        expect(wire.properties.featureFlagSchema.properties.enableNewUI).toEqual({ type: 'boolean' });

        // Standard public keys (ENV, CLOUD_PROVIDER, REGION, IS_LOCAL) are
        // merged into the public tier on the wire so the UI sees every key
        // the runtime will load.
        expect(wire.properties.publicConfigSchema.properties.ENV).toEqual({ type: 'string' });
        expect(wire.properties.publicConfigSchema.properties.IS_LOCAL).toEqual({ type: 'boolean' });

        type Types = InferConfigTypes<typeof config>;
        const _type: Types = {} as any; // type-level smoke check: compiles
        void _type;
    });

    it('tolerates missing optional tiers', () => {
        const config = defineConfig({
            publicConfigSchema: { apiUrl: StringSchema },
        });

        const wire = (config as any).serializedAllConfigSchemaJsonSchema;
        expect(wire.properties.secretConfigSchema.properties).toEqual({});
        expect(wire.properties.featureFlagSchema.properties).toEqual({});
    });
});
