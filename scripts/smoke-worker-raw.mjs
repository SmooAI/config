#!/usr/bin/env node
/** Raw worker_threads test — no synckit. Just verifies workers + message passing. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

const dir = mkdtempSync(join(tmpdir(), 'raw-'));
const file = join(dir, 'w.mjs');
writeFileSync(
    file,
    `
import { parentPort } from 'node:worker_threads';
parentPort.on('message', (m) => {
    parentPort.postMessage({ result: m * 2 });
});
parentPort.postMessage({ hello: 'from worker' });
`,
);

const worker = new Worker(file);
const msgs = [];
worker.on('message', (m) => msgs.push(m));
worker.on('error', (e) => console.error('[raw] error:', e));
worker.on('exit', (code) => console.log('[raw] exit:', code));

await new Promise((resolve) => setTimeout(resolve, 200));
worker.postMessage(21);
await new Promise((resolve) => setTimeout(resolve, 200));
console.log('[raw] msgs:', msgs);
await worker.terminate();
console.log('[raw] DONE');
