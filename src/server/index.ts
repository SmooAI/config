/* eslint-disable @typescript-eslint/no-explicit-any -- sync variants narrow at the call site */
/**
 * `@smooai/config/server` — unified server-side SDK.
 *
 * One SDK that resolves values through a priority chain:
 *
 *   Public + secret (chain):
 *     1. Baked blob       — AES-256-GCM `{public, secret}` map placed on
 *                           disk by the deploy-time baker. Highest priority
 *                           so production overrides win.
 *     2. Env vars         — `process.env[UPPER_SNAKE_CASE(key)]`. Per-key
 *                           overrides for CI / local shells.
 *     3. HTTP config API  — Live fetch from the Smoo AI config server.
 *     4. Local file       — Defaults shipped in repo under `.smooai-config/`.
 *
 *   Feature flags (chain):
 *     1. HTTP (live, 30s cache — flags are designed to flip without redeploy)
 *     2. Env vars
 *     3. Local file
 *     Blob is intentionally skipped — no flag ever gets baked.
 *
 * Exposes both async + sync accessors per tier so legacy sync call sites
 * (class constructors, module-level init) don't need to be refactored to
 * async. Sync variants dispatch through a synckit worker that runs the
 * async core on a worker thread and blocks the main thread until it
 * returns.
 *
 * Node-only — do not import this path in browser bundles. Use
 * `@smooai/config/client` instead.
 *
 * @example
 *   import { buildConfig } from '@smooai/config/server';
 *   import schema from '../../.smooai-config/config';
 *
 *   const config = buildConfig(schema);
 *
 *   // Async (idiomatic in handlers):
 *   const sendgridKey = await config.secretConfig.get('sendgridApiKey');
 *
 *   // Sync (drop-in for constructors / top-level init):
 *   const supabaseUrl = config.publicConfig.getSync('supabaseUrl');
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, InferConfigTypes } from '@/config/config';
import { createSyncFn } from 'synckit';
import { buildConfigAsync, BuildConfigAsyncOptions } from './internal';

export type { BuildConfigAsyncOptions as BuildConfigOptions } from './internal';
export { __resetServerCaches } from './internal';

/**
 * Resolve the compiled sync-worker path. tsup emits `dist/server/sync-worker.{js,mjs}`
 * alongside `index.{js,mjs}` so `__dirname` / `import.meta.url` point at the same
 * directory regardless of which module format the consumer loads.
 */
function resolveSyncWorkerPath(): string {
    // CJS build sets __dirname; ESM build doesn't. Fall through gracefully.
    // eslint-disable-next-line no-undef
    const dir = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(dir, 'sync-worker.js');
}

export function buildConfig<Schema extends ReturnType<typeof defineConfig>>(schema: Schema, options?: BuildConfigAsyncOptions) {
    type ConfigType = InferConfigTypes<Schema>['ConfigType'];
    type PublicKey = Extract<InferConfigTypes<Schema>['PublicConfigKeys'][keyof InferConfigTypes<Schema>['PublicConfigKeys']], keyof ConfigType>;
    type SecretKey = Extract<InferConfigTypes<Schema>['SecretConfigKeys'][keyof InferConfigTypes<Schema>['SecretConfigKeys']], keyof ConfigType>;
    type FlagKey = Extract<InferConfigTypes<Schema>['FeatureFlagKeys'][keyof InferConfigTypes<Schema>['FeatureFlagKeys']], keyof ConfigType>;

    const asyncCore = buildConfigAsync(schema, options);

    const workerPath = resolveSyncWorkerPath();
    // One worker per tier keeps bundles simple and lets synckit keep a
    // warm thread per tier so repeated reads in hot paths don't repay the
    // worker-spawn cost.
    const publicSync = createSyncFn(workerPath, { tsRunner: 'tsx' });
    const secretSync = createSyncFn(workerPath, { tsRunner: 'tsx' });
    const flagSync = createSyncFn(workerPath, { tsRunner: 'tsx' });

    return {
        publicConfig: {
            get: asyncCore.publicConfig.get,
            getSync: <K extends PublicKey>(key: K): ConfigType[K] | undefined => publicSync(schema, 'public', key) as ConfigType[K] | undefined,
        },
        secretConfig: {
            get: asyncCore.secretConfig.get,
            getSync: <K extends SecretKey>(key: K): ConfigType[K] | undefined => secretSync(schema, 'secret', key) as ConfigType[K] | undefined,
        },
        featureFlag: {
            get: asyncCore.featureFlag.get,
            getSync: <K extends FlagKey>(key: K): ConfigType[K] | undefined => flagSync(schema, 'flag', key) as ConfigType[K] | undefined,
        },
        invalidateCaches: asyncCore.invalidateCaches,
        getSource: asyncCore.getSource,
    };
}

export { buildConfigAsync };
