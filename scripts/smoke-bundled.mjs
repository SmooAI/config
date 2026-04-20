#!/usr/bin/env node
/**
 * Smoke test using the pre-bundled worker source — mirrors what the SDK
 * does at runtime (read WORKER_SOURCE string → write to /tmp → spawn).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSyncFn } from 'synckit';
const genSrc = readFileSync(new URL('../src/server/sync-worker-source.generated.ts', import.meta.url), 'utf8');
const WORKER_SOURCE = JSON.parse(/export const WORKER_SOURCE = (".+");/s.exec(genSrc)[1]);

const dir = mkdtempSync(join(tmpdir(), 'smoke-'));
const file = join(dir, 'sync-worker.mjs');
writeFileSync(file, WORKER_SOURCE);

console.log('[smoke] worker bytes:', WORKER_SOURCE.length);
console.log('[smoke] worker file :', file);

const syncFn = createSyncFn(pathToFileURL(file), { timeout: 5000 });

// Call with a minimal schema shape (untyped) and a key the worker will try
// to resolve through the priority chain. Blob + env are unset, HTTP fails
// fast (bogus URL), file tier doesn't have a .smooai-config/ dir — so we
// expect `undefined`. What we're actually testing here is that the WORKER
// RETURNS at all — proving the inline-worker path works.
process.env.SMOOAI_CONFIG_API_URL = 'http://127.0.0.1:1';

const schema = {
    publicConfigSchema: { foo: { type: 'string' } },
    secretConfigSchema: {},
    featureFlagSchema: {},
    PublicConfigKeys: { FOO: 'foo' },
    SecretConfigKeys: {},
    FeatureFlagKeys: {},
    AllConfigKeys: { FOO: 'foo' },
    serializedAllConfigSchema: { publicConfigSchema: { foo: { type: 'string' } }, secretConfigSchema: {}, featureFlagSchema: {} },
};

const started = Date.now();
try {
    const result = syncFn(schema, 'public', 'foo');
    console.log(`[smoke] OK — got "${result}" in ${Date.now() - started}ms`);
    process.exit(0);
} catch (err) {
    console.error(`[smoke] worker threw after ${Date.now() - started}ms:`, err);
    process.exit(1);
}
