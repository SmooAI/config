import { defineConfig, type Options } from 'tsup';

export default defineConfig((options: Options) => ({
    entry: [
        'src/index.ts',
        'src/getCloudRegion.ts',
        'src/findAndProcessConfig.ts',
        'src/config.ts',
        'src/SecretConfigKey.ts',
        'src/PublicConfigKey.ts',
        'src/FeatureFlagKey.ts',
        'src/utils/mergeReplaceArrays.ts',
        'src/utils/index.ts',
        'src/test/1/smooai-config/default.ts',
        'src/test/1/smooai-config/config.ts',
    ],
    clean: true,
    dts: true,
    format: ['cjs', 'esm'],
    sourcemap: true,
    target: 'es2022',
    treeShaking: true,
    ...options,
}));
