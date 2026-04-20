#!/usr/bin/env node
/** Inject a startup-logger into the bundled worker to verify it starts. */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const genSrc = readFileSync(new URL('../src/server/sync-worker-source.generated.ts', import.meta.url), 'utf8');
const workerSource = JSON.parse(/export const WORKER_SOURCE = (".+");/s.exec(genSrc)[1]);

const dir = mkdtempSync(join(tmpdir(), 'debug-'));
const logFile = join(dir, 'worker.log');
const probe = `
import { writeFileSync, appendFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(logFile)}, '[probe] worker top reached\\n');
try {
`;
const suffix = `
} catch (err) {
    appendFileSync(${JSON.stringify(logFile)}, '[probe] error: ' + err.stack + '\\n');
    throw err;
}
appendFileSync(${JSON.stringify(logFile)}, '[probe] worker bottom reached\\n');
`;
const file = join(dir, 'w.mjs');
writeFileSync(file, probe + workerSource + suffix);

const { createSyncFn } = await import('synckit');
const syncFn = createSyncFn(pathToFileURL(file), { timeout: 3000 });

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

try {
    const r = syncFn(schema, 'public', 'foo');
    console.log('[smoke] result:', r);
} catch (err) {
    console.log('[smoke] syncFn threw:', err.message);
}

console.log('\n[smoke] worker log:');
try {
    console.log(readFileSync(logFile, 'utf8'));
} catch {
    console.log('  (no log — worker never started)');
}
process.exit(0);
