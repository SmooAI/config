/* eslint-disable @typescript-eslint/no-explicit-any -- ok */
import { describe, expect, it } from 'vitest';
import z from 'zod';
import { defineConfig, InferConfigTypes, StringSchema } from './config';

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

        const { PublicConfigKeys, SecretConfigKeys, FeatureFlagKeys, parseConfig, get } = config;

        type configTypes = InferConfigTypes<typeof config>;
        type ConfigType = configTypes['ConfigType'];

        const testConfig: ConfigType = {
            [PublicConfigKeys.MY_PUBLIC_STRUCTURED_CONFIG]: {
                key: 'myPublicApiKey',
                value: 'myPublicApiKey',
            },
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

        expect(publicConfigKeys).toEqual(['myPublicApiKey', 'myPublicStructuredConfig', 'ENV', 'IS_LOCAL', 'REGION', 'CLOUD_PROVIDER']);
        expect(publicConfigKeys).toEqual([PublicConfigKeys.MY_PUBLIC_API_KEY, PublicConfigKeys.MY_PUBLIC_STRUCTURED_CONFIG, PublicConfigKeys.ENV, PublicConfigKeys.IS_LOCAL, PublicConfigKeys.REGION, PublicConfigKeys.CLOUD_PROVIDER]);
        expect(secretConfigKeys).toEqual(['mySecretApiKey', 'mySecretStructuredConfig']);
        expect(secretConfigKeys).toEqual([SecretConfigKeys.MY_SECRET_API_KEY, SecretConfigKeys.MY_SECRET_STRUCTURED_CONFIG]);
        expect(featureFlagKeys).toEqual(['enableNewUI', 'betaFeatures']);
        expect(featureFlagKeys).toEqual([FeatureFlagKeys.ENABLE_NEW_U_I, FeatureFlagKeys.BETA_FEATURES]);

        const parsedConfig = parseConfig(testConfig);
        expect(parsedConfig).toBeDefined();
        if (parsedConfig) {
            expect(parsedConfig.myPublicApiKey).toBe('test-public-key');
            expect(parsedConfig.mySecretApiKey).toBe('test-secret-key');
            expect(parsedConfig.enableNewUI).toBe('true');
            expect(parsedConfig.betaFeatures).toBeDefined();
            expect((parsedConfig.betaFeatures as any).enabled).toBe(true);
        }
    });
});
