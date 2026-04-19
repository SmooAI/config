import path from 'node:path';
import { fileURLToPath } from 'node:url';
import alias from 'esbuild-plugin-alias';
import { defineConfig, type Options } from 'tsup';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const serverEntry = [
    'src/index.ts',
    'src/vite/preloadConfig.ts',
    'src/vite/index.ts',
    'src/utils/mergeReplaceArrays.ts',
    'src/utils/index.ts',
    'src/utils/fs.ts',
    'src/schema-spec/smooai-config-schema-spec.ts',
    'src/react/index.ts',
    'src/react/hooks.ts',
    'src/platform/server.ts',
    'src/platform/client.ts',
    'src/platform/server/server.secretConfig.sync.ts',
    'src/platform/server/server.publicConfig.sync.ts',
    'src/platform/server/server.featureFlag.sync.ts',
    'src/platform/server/server.async.ts',
    'src/nextjs/index.ts',
    'src/nextjs/client.ts',
    'src/nextjs/hooks.ts',
    'src/nextjs/getConfig.ts',
    'src/nextjs/withFeatureFlags.ts',
    'src/nextjs/withSmooConfig.ts',
    'src/client/index.ts',
    'src/vite/smooConfigPlugin.ts',
    'src/integration-tests/2/smooai-config/production.ts',
    'src/integration-tests/2/smooai-config/production.aws.us-east-1.ts',
    'src/integration-tests/2/smooai-config/production.aws.ts',
    'src/integration-tests/2/smooai-config/development.ts',
    'src/integration-tests/2/smooai-config/default.ts',
    'src/integration-tests/2/smooai-config/config.ts',
    'src/integration-tests/1/smooai-config/staging.ts',
    'src/integration-tests/1/smooai-config/production.ts',
    'src/integration-tests/1/smooai-config/production.aws.us-east-2.ts',
    'src/integration-tests/1/smooai-config/production.aws.us-east-1.ts',
    'src/integration-tests/1/smooai-config/production.aws.ts',
    'src/integration-tests/1/smooai-config/development.ts',
    'src/integration-tests/1/smooai-config/default.ts',
    'src/integration-tests/1/smooai-config/config.ts',
    'src/config/standardSchemaToJson.ts',
    'src/config/parseConfigSchema.ts',
    'src/config/index.ts',
    'src/config/server.ts',
    'src/config/getCloudRegion.ts',
    'src/config/findAndProcessFileConfig.ts',
    'src/config/findAndProcessEnvConfig.ts',
    'src/config/config.ts',
    'src/config/SecretConfigKey.ts',
    'src/config/PublicConfigKey.ts',
    'src/config/FeatureFlagKey.ts',
    'src/feature-flags/index.ts',
];

const browserEntry = [
    'src/config/index.ts',
    'src/config/config.ts',
    'src/config/FeatureFlagKey.ts',
    'src/config/PublicConfigKey.ts',
    'src/config/SecretConfigKey.ts',
    'src/config/getCloudRegion.ts',
    'src/config/parseConfigSchema.ts',
    'src/feature-flags/index.ts',
    'src/client/index.ts',
    'src/platform/client.ts',
    'src/react/index.ts',
    'src/react/hooks.ts',
    'src/react/ConfigProvider.tsx',
    'src/nextjs/index.ts',
    'src/nextjs/client.ts',
    'src/nextjs/hooks.ts',
    'src/nextjs/getConfig.ts',
    'src/vite/index.ts',
    'src/vite/preloadConfig.ts',
    'src/utils/index.ts',
    'src/utils/mergeReplaceArrays.ts',
];

const nodeStub = path.resolve(__dirname, 'src/stubs/node-deps.stub.ts');
const schemaStub = path.resolve(__dirname, 'src/stubs/standard-schema-serializer.stub.ts');

const aliasedModules = [
    '@smooai/logger/Logger',
    'esm-utils',
    '@valibot/to-json-schema',
    'arktype',
    'effect',
    'effect/JSONSchema',
    'json-schema-to-zod',
    'rotating-file-stream',
];

const aliasMap: Record<string, string> = {};
for (const mod of aliasedModules) {
    aliasMap[mod] =
        mod === '@valibot/to-json-schema' || mod === 'arktype' || mod === 'effect' || mod === 'effect/JSONSchema' || mod === 'json-schema-to-zod'
            ? schemaStub
            : nodeStub;
}

export default defineConfig((options: Options) => [
    {
        entry: serverEntry,
        clean: true,
        dts: true,
        format: ['cjs', 'esm'],
        sourcemap: true,
        target: 'es2022',
        treeShaking: true,
        ...options,
    },
    {
        entry: browserEntry,
        outDir: 'dist/browser',
        clean: false,
        dts: true,
        format: ['esm'],
        platform: 'browser',
        sourcemap: true,
        target: 'es2022',
        treeShaking: true,
        // Mark Node.js-only deps as non-external so esbuild resolves them through our alias plugin
        noExternal: aliasedModules,
        esbuildPlugins: [alias(aliasMap)],
    },
]);
