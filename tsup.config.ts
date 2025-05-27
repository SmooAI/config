import { defineConfig, type Options } from 'tsup';

export default defineConfig((options: Options) => ({
    entry: ['src/index.ts','src/utils/mergeReplaceArrays.ts','src/utils/index.ts','src/utils/fs.ts','src/test/smooai-config/default.ts','src/test/smooai-config/config.ts','src/platform/server.ts','src/platform/server/server.secretConfig.sync.ts','src/platform/server/server.publicConfig.sync.ts','src/platform/server/server.featureFlag.sync.ts','src/platform/server/server.async.ts','src/config/standardSchemaToJson.ts','src/config/parseConfigSchema.ts','src/config/index.ts','src/config/getCloudRegion.ts','src/config/findAndProcessFileConfig.ts','src/config/findAndProcessEnvConfig.ts','src/config/config.ts','src/config/SecretConfigKey.ts','src/config/PublicConfigKey.ts','src/config/FeatureFlagKey.ts'],
    clean: true,
    dts: true,
    format: ['cjs', 'esm'],
    sourcemap: true,
    target: 'es2022',
    treeShaking: true,
    ...options,
}));
