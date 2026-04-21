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
    'src/server/index.ts',
    'src/server/internal.ts',
    'src/server/sync-worker.ts',
    'src/platform/client.ts',
    'src/platform/build.ts',
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

// Node-only modules we still alias to stubs in the browser build. Schema
// serializers (arktype / effect / valibot adapter / json-schema-to-zod) use
// `esm-utils` (which evals CJS), so they can never ship to the browser —
// we stub them with a schema-only no-op. `rotating-file-stream` is defensive:
// nothing should resolve it now that `@smooai/logger` has a top-level
// `browser` export condition, but keeping the alias means a stray import
// from a transitive dep can't break consumer bundles.
const aliasedModules = ['esm-utils', '@valibot/to-json-schema', 'arktype', 'effect', 'effect/JSONSchema', 'json-schema-to-zod', 'rotating-file-stream'];

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
        // Non-external so esbuild routes these through the alias plugin
        // and substitutes the stubs.
        //
        // `@smooai/fetch` is inlined (kept non-external) in the browser
        // build on purpose: `platform: 'browser'` does pick up fetch's
        // `browser` export condition automatically, but only if the
        // consumer's resolution of `@smooai/fetch` lands on ≥3.1.0. If a
        // consumer pins the old major (2.x) somewhere else in its tree,
        // their browser build would fall back to fetch's Node entry and
        // pull `rotating-file-stream` + logger. Bundling fetch into the
        // browser dist here makes the browser build self-contained and
        // immune to consumer-side resolution surprises. The cost is a
        // small duplicated payload (~few KB) — worth it for robustness.
        noExternal: [...aliasedModules, '@smooai/fetch'],
        esbuildPlugins: [alias(aliasMap)],
    },
]);
