#!/usr/bin/env node
/**
 * Minimal smoke test: can we spawn a synckit worker from a file we just wrote to /tmp?
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSyncFn } from 'synckit';

const WORKER_SRC = `
import { runAsWorker } from 'synckit';
runAsWorker(async (x) => x * 2);
`;

const dir = mkdtempSync(join(tmpdir(), 'smoke-'));
const file = join(dir, 'worker.mjs');
writeFileSync(file, WORKER_SRC);
const url = pathToFileURL(file);

console.log('[smoke] worker file:', file);
console.log('[smoke] url:', url.toString());

const syncFn = createSyncFn(url, { timeout: 5000 });
const result = syncFn(21);
console.log('[smoke] result:', result);
if (result !== 42) {
    console.error('[smoke] FAILED: expected 42, got', result);
    process.exit(1);
}
console.log('[smoke] OK');
process.exit(0);
