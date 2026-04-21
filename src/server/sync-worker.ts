/* eslint-disable @typescript-eslint/no-explicit-any -- synckit worker marshals schema + args across the thread boundary */
/**
 * Synckit worker entry for `@smooai/config/server`. Runs inside a worker
 * thread spawned by `createSyncFn` so the main thread can block on the
 * full async priority chain (blob → env → HTTP → file).
 *
 * Do NOT import `./index` here — that file creates synckit workers itself,
 * which would recurse. Use the async-only core directly.
 *
 * Protocol: returns `{ value, source }`. The source is the tier that
 * actually produced the value (`'blob' | 'env' | 'http' | 'file' | undefined`).
 * The parent thread copies `source` into its own `lastSource` map so
 * `cfg.getSource(key)` works after a `.getSync()` call too — each worker
 * has its own module scope, so without explicit propagation the parent's
 * diagnostic map never sees sync reads.
 */
import { runAsWorker } from 'synckit';
import { buildConfigAsync } from './internal';

type Tier = 'public' | 'secret' | 'flag';
type Source = 'blob' | 'env' | 'http' | 'file' | undefined;

runAsWorker(async function serverSyncWorker(...args: any[]): Promise<{ value: unknown; source: Source }> {
    const schema = args[0];
    const tier = args[1] as Tier;
    const key = args[2] as string;

    const cfg = buildConfigAsync(schema);
    let value: unknown;
    if (tier === 'public') value = await cfg.publicConfig.get(key as never);
    else if (tier === 'secret') value = await cfg.secretConfig.get(key as never);
    else if (tier === 'flag') value = await cfg.featureFlag.get(key as never);
    else throw new Error(`[server sync-worker] unknown tier: ${tier}`);

    return { value, source: cfg.getSource(key) };
});
