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
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineConfig, InferConfigTypes } from '@/config/config';
import { createSyncFn } from 'synckit';
import { buildConfigAsync, BuildConfigAsyncOptions } from './internal';
import { WORKER_SOURCE } from './sync-worker-source.generated';

export type { BuildConfigAsyncOptions as BuildConfigOptions } from './internal';
export { __resetServerCaches } from './internal';

/**
 * Resolve the worker file URL for synckit. Two paths, in order:
 *
 *   1. **Sidecar file** — `./sync-worker.mjs` sitting next to the compiled
 *      SDK entry. This is the normal case when the consumer does not bundle
 *      (plain Node resolution from `node_modules/@smooai/config/dist/server/`)
 *      or when the bundler copies the sidecar (SST `copyFiles`, esbuild with
 *      the `new URL(..., import.meta.url)` asset hint, etc.). Zero /tmp write,
 *      zero cold-start cost beyond what synckit itself pays.
 *
 *   2. **Extracted from `WORKER_SOURCE`** (SMOODEV-617 fallback) — the worker
 *      body is also embedded as a bundled ESM string literal in
 *      `sync-worker-source.generated.ts`. If the sidecar isn't on disk
 *      (single-file bundled Lambda with no copyFiles), we write the string
 *      to `mkdtempSync()/sync-worker.mjs` once per process and hand that
 *      `file://` URL to synckit. One-time ~1-2 MiB write to `/tmp`.
 *
 * Why not a `data:` URL directly? `createSyncFn` passes the URL through
 * `fileURLToPath` unconditionally — only `file://` works.
 *
 * How to keep this on path (1) on AWS Lambda via SST:
 *
 * ```ts
 * // sst.config.ts
 * new sst.aws.Function('Api', {
 *   handler: 'src/api.handler',
 *   copyFiles: [
 *     { from: 'node_modules/@smooai/config/dist/server/sync-worker.mjs' },
 *   ],
 * });
 * ```
 *
 * Or at the project level via `$transform` so every `Function` gets it:
 *
 * ```ts
 * $transform(sst.aws.Function, (fn) => {
 *   fn.copyFiles = [
 *     ...(fn.copyFiles ?? []),
 *     { from: 'node_modules/@smooai/config/dist/server/sync-worker.mjs' },
 *   ];
 * });
 * ```
 *
 * Vercel edge runtimes don't have `worker_threads` at all, so `.getSync()`
 * is unavailable there by design — `.get()` (async) works everywhere.
 */
let cachedWorkerUrl: URL | undefined;

function ensureWorkerFile(): URL {
    if (cachedWorkerUrl) return cachedWorkerUrl;

    // Path 1 — sidecar file next to the compiled SDK entry.
    try {
        const sidecar = new URL('./sync-worker.mjs', import.meta.url);
        if (existsSync(fileURLToPath(sidecar))) {
            cachedWorkerUrl = sidecar;
            return cachedWorkerUrl;
        }
    } catch {
        // `new URL` can throw in exotic environments (Deno compile, etc.).
        // Fall through to the embedded-source extraction path.
    }

    // Path 2 — extract the embedded worker source to /tmp.
    const dir = mkdtempSync(join(tmpdir(), 'smooai-config-'));
    const filePath = join(dir, 'sync-worker.mjs');
    writeFileSync(filePath, WORKER_SOURCE);
    cachedWorkerUrl = pathToFileURL(filePath);
    return cachedWorkerUrl;
}

export function buildConfig<Schema extends ReturnType<typeof defineConfig>>(schema: Schema, options?: BuildConfigAsyncOptions) {
    type ConfigType = InferConfigTypes<Schema>['ConfigType'];
    type PublicKey = Extract<InferConfigTypes<Schema>['PublicConfigKeys'][keyof InferConfigTypes<Schema>['PublicConfigKeys']], keyof ConfigType>;
    type SecretKey = Extract<InferConfigTypes<Schema>['SecretConfigKeys'][keyof InferConfigTypes<Schema>['SecretConfigKeys']], keyof ConfigType>;
    type FlagKey = Extract<InferConfigTypes<Schema>['FeatureFlagKeys'][keyof InferConfigTypes<Schema>['FeatureFlagKeys']], keyof ConfigType>;

    const asyncCore = buildConfigAsync(schema, options);

    // One worker per tier keeps bundles simple and lets synckit keep a
    // warm thread per tier so repeated reads in hot paths don't repay the
    // worker-spawn cost.
    const workerUrl = ensureWorkerFile();
    const publicSync = createSyncFn(workerUrl);
    const secretSync = createSyncFn(workerUrl);
    const flagSync = createSyncFn(workerUrl);

    // The synckit worker returns `{ value, source }`. Unpack it, record the
    // source on the parent-thread's `lastSource` map (each worker has its
    // own module scope, so without this `getSource` never sees sync reads),
    // and hand the value back to the caller.
    type WorkerEnvelope = { value: unknown; source: 'blob' | 'env' | 'http' | 'file' | undefined };
    const unpack = <T>(envelope: WorkerEnvelope, key: string): T | undefined => {
        asyncCore.recordSource(key, envelope.source);
        return envelope.value as T | undefined;
    };

    return {
        publicConfig: {
            get: asyncCore.publicConfig.get,
            getSync: <K extends PublicKey>(key: K): ConfigType[K] | undefined =>
                unpack<ConfigType[K]>(publicSync(schema, 'public', key) as WorkerEnvelope, key as string),
        },
        secretConfig: {
            get: asyncCore.secretConfig.get,
            getSync: <K extends SecretKey>(key: K): ConfigType[K] | undefined =>
                unpack<ConfigType[K]>(secretSync(schema, 'secret', key) as WorkerEnvelope, key as string),
        },
        featureFlag: {
            get: asyncCore.featureFlag.get,
            getSync: <K extends FlagKey>(key: K): ConfigType[K] | undefined =>
                unpack<ConfigType[K]>(flagSync(schema, 'flag', key) as WorkerEnvelope, key as string),
        },
        invalidateCaches: asyncCore.invalidateCaches,
        getSource: asyncCore.getSource,
    };
}

export { buildConfigAsync };
