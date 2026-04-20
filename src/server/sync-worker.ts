/* eslint-disable @typescript-eslint/no-explicit-any -- synckit worker marshals schema + args across the thread boundary */
/**
 * Synckit worker entry for `@smooai/config/server`. Runs inside a worker
 * thread spawned by `createSyncFn` so the main thread can block on the
 * full async priority chain (blob → env → HTTP → file).
 *
 * Do NOT import `./index` here — that file creates synckit workers itself,
 * which would recurse. Use the async-only core directly.
 */
import { runAsWorker } from 'synckit';
import { buildConfigAsync } from './internal';

type Tier = 'public' | 'secret' | 'flag';

runAsWorker(async function serverSyncWorker(...args: any[]) {
    const schema = args[0];
    const tier = args[1] as Tier;
    const key = args[2] as string;

    const cfg = buildConfigAsync(schema);
    if (tier === 'public') return cfg.publicConfig.get(key as never);
    if (tier === 'secret') return cfg.secretConfig.get(key as never);
    if (tier === 'flag') return cfg.featureFlag.get(key as never);
    throw new Error(`[server sync-worker] unknown tier: ${tier}`);
});
