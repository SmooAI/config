/* eslint-disable @typescript-eslint/no-explicit-any -- ok */
import { findAndProcessFileConfig } from '@/config/findAndProcessFileConfig';
import { findAndProcessEnvConfig } from '@/config/findAndProcessEnvConfig';
import { InferConfigTypes, defineConfig } from '@/config/config';
import { LRUCache } from 'lru-cache';
import TTLCache from '@isaacs/ttlcache';

const FILE_CONFIG_CACHE = new LRUCache<string, Awaited<ReturnType<typeof findAndProcessFileConfig>>>({
    max: 1,
});
const FILE_CONFIG_CACHE_KEY = 'fileConfig';

const ENV_CONFIG_CACHE = new LRUCache<string, Awaited<ReturnType<typeof findAndProcessEnvConfig>>>({
    max: 1,
});
const ENV_CONFIG_CACHE_KEY = 'envConfig';

const IS_INITIALIZED_CACHE = new LRUCache<string, boolean>({
    max: 1,
});
const IS_INITIALIZED_CACHE_KEY = 'isInitialized';

const PUBLIC_CONFIG_CACHE = new TTLCache<string, any>({
    ttl: 1000 * 60 * 60 * 24,
});

const SECRET_CONFIG_CACHE = new TTLCache<string, any>({
    ttl: 1000 * 60 * 60 * 24,
});

const FEATURE_FLAG_CACHE = new TTLCache<string, any>({
    ttl: 1000 * 60 * 60 * 24,
});

async function loadFileConfig<Schema extends ReturnType<typeof defineConfig>>(configSchema: Schema) {
    let fileConfig = FILE_CONFIG_CACHE.get(FILE_CONFIG_CACHE_KEY);
    if (fileConfig) {
        return fileConfig;
    }
    fileConfig = await findAndProcessFileConfig(configSchema);
    FILE_CONFIG_CACHE.set(FILE_CONFIG_CACHE_KEY, fileConfig.config);
    return fileConfig.config;
}

function loadEnvConfig<Schema extends ReturnType<typeof defineConfig>>(configSchema: Schema) {
    let envConfig = ENV_CONFIG_CACHE.get(ENV_CONFIG_CACHE_KEY);
    if (envConfig) {
        return envConfig;
    }
    envConfig = findAndProcessEnvConfig(configSchema);
    ENV_CONFIG_CACHE.set(ENV_CONFIG_CACHE_KEY, envConfig.config);
    return envConfig.config;
}

async function initialize<Schema extends ReturnType<typeof defineConfig>>(configSchema: Schema) {
    const isInitialized = IS_INITIALIZED_CACHE.get(IS_INITIALIZED_CACHE_KEY);
    if (isInitialized) {
        return;
    }
    await loadFileConfig(configSchema);
    await loadEnvConfig(configSchema);
}

export default function buildConfigObject<Schema extends ReturnType<typeof defineConfig>>(configSchema: Schema) {
    type ConfigType = InferConfigTypes<Schema>['ConfigType'];
    const PublicConfigKeys = configSchema.PublicConfigKeys;
    type PublicConfigKeys = InferConfigTypes<Schema>['PublicConfigKeys'];
    type SecretConfigKeys = InferConfigTypes<Schema>['SecretConfigKeys'];
    type FeatureFlagKeys = InferConfigTypes<Schema>['FeatureFlagKeys'];

    type PublicConfigKey = Extract<PublicConfigKeys[keyof PublicConfigKeys], keyof ConfigType>;
    type SecretConfigKey = Extract<SecretConfigKeys[keyof SecretConfigKeys], keyof ConfigType>;
    type FeatureFlagKey = Extract<FeatureFlagKeys[keyof FeatureFlagKeys], keyof ConfigType>;

    async function getPublicConfig<K extends PublicConfigKey>(key: K): Promise<ConfigType[K] | undefined> {
        const cachedValue = PUBLIC_CONFIG_CACHE.get(key as string);
        if (cachedValue) {
            return cachedValue;
        }

        await initialize(configSchema);

        if (FILE_CONFIG_CACHE.get(FILE_CONFIG_CACHE_KEY)?.[key] !== undefined) {
            PUBLIC_CONFIG_CACHE.set(key as string, FILE_CONFIG_CACHE.get(FILE_CONFIG_CACHE_KEY)?.[key]);
            return FILE_CONFIG_CACHE.get(FILE_CONFIG_CACHE_KEY)?.[key];
        }
        if (ENV_CONFIG_CACHE.get(ENV_CONFIG_CACHE_KEY)?.[key] !== undefined) {
            PUBLIC_CONFIG_CACHE.set(key as string, ENV_CONFIG_CACHE.get(ENV_CONFIG_CACHE_KEY)?.[key]);
            return ENV_CONFIG_CACHE.get(ENV_CONFIG_CACHE_KEY)?.[key];
        }
        return undefined;
    }

    async function getSecretConfig<K extends SecretConfigKey>(key: K): Promise<ConfigType[K] | undefined> {
        const cachedValue = SECRET_CONFIG_CACHE.get(key as string);
        if (cachedValue) {
            return cachedValue;
        }

        await initialize(configSchema);

        if (FILE_CONFIG_CACHE.get(FILE_CONFIG_CACHE_KEY)?.[key] !== undefined) {
            SECRET_CONFIG_CACHE.set(key as string, FILE_CONFIG_CACHE.get(FILE_CONFIG_CACHE_KEY)?.[key]);
            return FILE_CONFIG_CACHE.get(FILE_CONFIG_CACHE_KEY)?.[key];
        }
        if (ENV_CONFIG_CACHE.get(ENV_CONFIG_CACHE_KEY)?.[key] !== undefined) {
            SECRET_CONFIG_CACHE.set(key as string, ENV_CONFIG_CACHE.get(ENV_CONFIG_CACHE_KEY)?.[key]);
            return ENV_CONFIG_CACHE.get(ENV_CONFIG_CACHE_KEY)?.[key];
        }
        return undefined;
    }

    async function getFeatureFlag<K extends FeatureFlagKey>(key: K): Promise<ConfigType[K] | undefined> {
        const cachedValue = FEATURE_FLAG_CACHE.get(key as string);
        if (cachedValue) {
            return cachedValue;
        }

        await initialize(configSchema);

        if (FILE_CONFIG_CACHE.get(FILE_CONFIG_CACHE_KEY)?.[key] !== undefined) {
            FEATURE_FLAG_CACHE.set(key as string, FILE_CONFIG_CACHE.get(FILE_CONFIG_CACHE_KEY)?.[key]);
            return FILE_CONFIG_CACHE.get(FILE_CONFIG_CACHE_KEY)?.[key];
        }
        if (ENV_CONFIG_CACHE.get(ENV_CONFIG_CACHE_KEY)?.[key] !== undefined) {
            FEATURE_FLAG_CACHE.set(key as string, ENV_CONFIG_CACHE.get(ENV_CONFIG_CACHE_KEY)?.[key]);
            return ENV_CONFIG_CACHE.get(ENV_CONFIG_CACHE_KEY)?.[key];
        }
        return undefined;
    }

    return {
        getPublicConfig,
        getSecretConfig,
        getFeatureFlag,
    };
}
