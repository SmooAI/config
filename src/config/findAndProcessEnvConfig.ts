/* eslint-disable @typescript-eslint/no-explicit-any -- ok */
import { initEsmUtils } from '@/utils';
import Logger from '@smooai/logger/Logger';
import { envToUse } from '@/utils';
import { getCloudRegion } from './getCloudRegion';
import { PublicConfigKey } from '@/config/PublicConfigKey';
import { defineConfig, InferConfigTypes } from './config';
import { parseConfigKey, generateZodSchemas } from './parseConfigSchema';
initEsmUtils();

const logger = new Logger({
    name: global.__filename,
});

/**
 * Process environment variables into a configuration object.
 *
 * @param configSchema - The configuration schema to validate against
 * @param prefix - Optional prefix for public config keys (e.g. 'NEXT_PUBLIC_' or 'VITE_')
 * @returns The processed configuration object
 */
export function findAndProcessEnvConfig<Schema extends ReturnType<typeof defineConfig>>(
    configSchema: Schema,
    prefix: string = '',
): {
    config: InferConfigTypes<Schema>['ConfigType'];
} {
    let finalConfig: Record<string, any> = {};
    try {
        const env = envToUse();
        const isLocal = Boolean(env.IS_LOCAL);
        const { provider, region } = getCloudRegion();

        const allConfigKeysValuesSet = new Set(Object.values(configSchema.AllConfigKeys));

        const { allConfigZodSchema } = generateZodSchemas(configSchema);

        // Process all environment variables
        for (const [key, value] of Object.entries(env)) {
            const keyToUse = prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key;

            if (!allConfigKeysValuesSet.has(keyToUse)) {
                continue;
            }

            try {
                // Try to parse the value according to the schema
                finalConfig[keyToUse] = parseConfigKey(allConfigZodSchema, keyToUse, value);
            } catch (err) {
                logger.warn(`Failed to parse environment variable ${key}:`, err);
            }
        }

        // Set built-in configuration values
        finalConfig = setBuiltInConfig(finalConfig, {
            env: env.SMOOAI_CONFIG_ENV ?? 'development',
            region,
            provider,
            isLocal,
        });
    } catch (err) {
        logger.error('Error processing environment variables:', err);
        throw err;
    }

    return {
        config: finalConfig,
    };
}

function setBuiltInConfig(
    config: Record<string, any>,
    {
        env,
        region,
        provider,
        isLocal,
    }: {
        env: string;
        region: string;
        provider: string;
        isLocal: boolean;
    },
) {
    config[PublicConfigKey.ENV] = env;
    config[PublicConfigKey.REGION] = region;
    config[PublicConfigKey.CLOUD_PROVIDER] = provider;
    config[PublicConfigKey.IS_LOCAL] = isLocal;

    return config;
}
