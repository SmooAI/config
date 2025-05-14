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
        );

        const { PublicConfigKeys, SecretConfigKeys, AllConfigKeys, parseConfig } = config;

        type configTypes = InferConfigTypes<typeof config>;
        type ConfigType = configTypes['ConfigType'];

        const blah: ConfigType = {
            [PublicConfigKeys.ENV]: 'myPublicApiKey',
            [AllConfigKeys.MY_PUBLIC_STRUCTURED_CONFIG]: {
                key: 'myPublicApiKey',
                value: 'myPublicApiKey',
            },
        };

        expect(publicConfigKeys).toEqual(['myPublicApiKey', 'myPublicStructuredConfig', 'ENV', 'IS_LOCAL', 'REGION', 'CLOUD_PROVIDER']);
        expect(publicConfigKeyKeys).toEqual(['MY_PUBLIC_API_KEY', 'MY_PUBLIC_STRUCTURED_CONFIG', 'ENV', 'IS_LOCAL', 'REGION', 'CLOUD_PROVIDER']);

        expect(publicConfigZodSchema.parse({}));
    });
});
