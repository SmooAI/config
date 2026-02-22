import { defineConfig, InferConfigTypes } from '@/config/config';
import buildConfigObjectAsync from './server/server.async';
import { createSyncFn } from 'synckit';
import path from 'path';

export default function buildConfigObject<Schema extends ReturnType<typeof defineConfig>>(configSchema: Schema) {
    type ConfigType = InferConfigTypes<Schema>['ConfigType'];
    const PublicConfigKeys = configSchema.PublicConfigKeys;
    type PublicConfigKeys = InferConfigTypes<Schema>['PublicConfigKeys'];
    type SecretConfigKeys = InferConfigTypes<Schema>['SecretConfigKeys'];
    type FeatureFlagKeys = InferConfigTypes<Schema>['FeatureFlagKeys'];

    type PublicConfigKey = Extract<PublicConfigKeys[keyof PublicConfigKeys], keyof ConfigType>;
    type SecretConfigKey = Extract<SecretConfigKeys[keyof SecretConfigKeys], keyof ConfigType>;
    type FeatureFlagKey = Extract<FeatureFlagKeys[keyof FeatureFlagKeys], keyof ConfigType>;

    const config = buildConfigObjectAsync(configSchema);

    const buildAndGetPublicConfigSync = createSyncFn(path.resolve(__dirname, '../../dist/platform/server/server.publicConfig.sync.js'), {
        tsRunner: 'tsx',
    });
    const buildAndGetSecretConfigSync = createSyncFn(path.resolve(__dirname, '../../dist/platform/server/server.secretConfig.sync.js'), {
        tsRunner: 'tsx',
    });
    const buildAndGetFeatureFlagSync = createSyncFn(path.resolve(__dirname, '../../dist/platform/server/server.featureFlag.sync.js'), {
        tsRunner: 'tsx',
    });

    function getPublicConfigSync<K extends PublicConfigKey>(key: K): ConfigType[K] | undefined {
        return buildAndGetPublicConfigSync(configSchema, key);
    }

    function getSecretConfigSync<K extends SecretConfigKey>(key: K): ConfigType[K] | undefined {
        return buildAndGetSecretConfigSync(configSchema, key);
    }

    function getFeatureFlagSync<K extends FeatureFlagKey>(key: K): ConfigType[K] | undefined {
        return buildAndGetFeatureFlagSync(configSchema, key);
    }

    return {
        publicConfig: {
            getAsync: config.getPublicConfig,
            getSync: getPublicConfigSync,
        },
        secretConfig: {
            getAsync: config.getSecretConfig,
            getSync: getSecretConfigSync,
        },
        featureFlag: {
            getAsync: config.getFeatureFlag,
            getSync: getFeatureFlagSync,
        },
    };
}
