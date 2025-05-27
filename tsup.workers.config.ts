import { defineConfig, type Options } from 'tsup';

export default defineConfig((options: Options) => ({
    entry: [
        'src/platform/server/server.featureFlag.sync.ts',
        'src/platform/server/server.publicConfig.sync.ts',
        'src/platform/server/server.secretConfig.sync.ts',
    ],
    outDir: 'src/platform/server',
    format: ['esm'],
    target: 'es2022',
    treeshake: true,
    ...options,
}));
