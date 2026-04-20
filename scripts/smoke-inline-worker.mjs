#!/usr/bin/env node
/**
 * Smoke test for SMOODEV-617 — verify `.getSync()` works with the inline
 * synckit worker (data-URL encoded). Success = both sync + async reads
 * resolve to the same known-good value in under ~5s.
 *
 * Run: node scripts/smoke-inline-worker.mjs
 */
import crypto from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, StringSchema } from '../dist/config/index.mjs';
import { buildConfig } from '../dist/server/index.mjs';

const tmp = join(tmpdir(), `smoke-${crypto.randomBytes(6).toString('hex')}`);
mkdirSync(tmp, { recursive: true });

try {
    // Bake a tiny blob with known values.
    const key = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const plaintext = Buffer.from(JSON.stringify({ public: { apiUrl: 'https://api.smoke.example' }, secret: { tavilyApiKey: 'tvly-smoke' } }), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const blob = Buffer.concat([nonce, ciphertext, authTag]);
    const blobPath = join(tmp, 'smoo-config.enc');
    writeFileSync(blobPath, blob);

    process.env.SMOO_CONFIG_KEY_FILE = blobPath;
    process.env.SMOO_CONFIG_KEY = key.toString('base64');
    // Prevent the HTTP fallback from trying to hit a real server.
    process.env.SMOOAI_CONFIG_API_URL = 'http://127.0.0.1:1';

    const schema = defineConfig({
        publicConfigSchema: { apiUrl: StringSchema },
        secretConfigSchema: { tavilyApiKey: StringSchema },
        featureFlagSchema: {},
    });

    const cfg = buildConfig(schema);

    const startSync = Date.now();
    const apiUrlSync = cfg.publicConfig.getSync('apiUrl');
    const syncMs = Date.now() - startSync;

    const apiUrlAsync = await cfg.publicConfig.get('apiUrl');

    const tavilySync = cfg.secretConfig.getSync('tavilyApiKey');

    console.log('SYNC read      :', apiUrlSync, `(${syncMs}ms incl. worker spawn)`);
    console.log('ASYNC read     :', apiUrlAsync);
    console.log('SECRET sync    :', tavilySync);

    if (apiUrlSync !== 'https://api.smoke.example') throw new Error(`sync apiUrl mismatch: ${apiUrlSync}`);
    if (apiUrlAsync !== 'https://api.smoke.example') throw new Error(`async apiUrl mismatch: ${apiUrlAsync}`);
    if (tavilySync !== 'tvly-smoke') throw new Error(`sync tavily mismatch: ${tavilySync}`);

    console.log('\n✅ SMOOTH: inline worker + priority chain work end-to-end');
    process.exit(0);
} catch (err) {
    console.error('\n❌ FAILED:', err);
    process.exit(1);
} finally {
    rmSync(tmp, { recursive: true, force: true });
}
