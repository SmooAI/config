/**
 * The file-defaults tier (`.smooai-config/`) is optional. In container mode
 * there is no such directory on disk by design (values come from the baked
 * blob), so a missing directory must skip the tier quietly instead of logging
 * an ERROR on every cold init. A config file that exists but is broken must
 * still log at ERROR.
 */
import crypto from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, StringSchema } from '@/config/config';
import type { ConfigClient } from '@/platform/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Logger from '@smooai/logger/Logger';
import { __resetServerCaches, buildConfigAsync } from './internal';

vi.mock('@smooai/logger/Logger');

const schema = defineConfig({
    publicConfigSchema: { apiUrl: StringSchema, fileOnlyKey: StringSchema },
});

// No HTTP tier: every lookup falls through to the file tier.
const httpClient = { getValue: vi.fn(async () => undefined) } as unknown as ConfigClient;

function writeBlob(dir: string, payload: unknown): { keyFile: string; keyB64: string } {
    const key = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    const keyFile = join(dir, 'smoo-config.blob');
    writeFileSync(keyFile, Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]));
    return { keyFile, keyB64: key.toString('base64') };
}

describe('file-defaults tier logging', () => {
    const originalEnv = process.env;
    let root: string;
    let cwd: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'smooai-config-file-defaults-'));
        cwd = join(root, 'app', 'apps', 'ts-worker');
        mkdirSync(cwd, { recursive: true });
        vi.spyOn(process, 'cwd').mockReturnValue(cwd);

        const { keyFile, keyB64 } = writeBlob(root, { public: { apiUrl: 'https://api.example.com' }, secret: {} });
        process.env = { ...originalEnv, SMOO_CONFIG_KEY_FILE: keyFile, SMOO_CONFIG_KEY: keyB64, SMOOAI_CONFIG_LEVELS_UP_LIMIT: '2' };
        delete process.env.SMOOAI_ENV_CONFIG_DIR;
        delete process.env.FILE_ONLY_KEY;
        __resetServerCaches();
    });

    afterEach(() => {
        process.env = originalEnv;
        vi.restoreAllMocks();
        vi.clearAllMocks();
        rmSync(root, { recursive: true, force: true });
    });

    it('skips the tier without an ERROR or WARN when there is no .smooai-config/ (container mode)', async () => {
        const cfg = buildConfigAsync(schema, { httpClient });

        expect(await cfg.publicConfig.get('apiUrl')).toBe('https://api.example.com');
        expect(cfg.getSource('apiUrl')).toBe('blob');
        expect(await cfg.publicConfig.get('fileOnlyKey')).toBeUndefined();

        expect(vi.mocked(Logger.prototype.error)).not.toHaveBeenCalled();
        expect(vi.mocked(Logger.prototype.warn)).not.toHaveBeenCalled();
        expect(vi.mocked(Logger.prototype.info)).toHaveBeenCalledWith('No local .smooai-config/ defaults; tier skipped');
    });

    it('skips the tier without an ERROR when .smooai-config/ has no default.ts', async () => {
        mkdirSync(join(cwd, '.smooai-config'));
        const cfg = buildConfigAsync(schema, { httpClient });

        expect(await cfg.publicConfig.get('fileOnlyKey')).toBeUndefined();

        expect(vi.mocked(Logger.prototype.error)).not.toHaveBeenCalled();
        expect(vi.mocked(Logger.prototype.warn)).not.toHaveBeenCalled();
    });

    it('still logs at ERROR when default.ts exists but is broken', async () => {
        mkdirSync(join(cwd, '.smooai-config'));
        writeFileSync(join(cwd, '.smooai-config', 'default.ts'), 'export default { fileOnlyKey: ;\n');
        const cfg = buildConfigAsync(schema, { httpClient });

        expect(await cfg.publicConfig.get('fileOnlyKey')).toBeUndefined();

        expect(vi.mocked(Logger.prototype.error)).toHaveBeenCalled();
        expect(vi.mocked(Logger.prototype.warn)).toHaveBeenCalledWith(expect.anything(), 'Failed to load local .smooai-config/ defaults; tier skipped');
    });

    it('serves the tier when default.ts exists and is valid', async () => {
        mkdirSync(join(cwd, '.smooai-config'));
        writeFileSync(join(cwd, '.smooai-config', 'default.ts'), "export default { fileOnlyKey: 'from-file' };\n");
        const cfg = buildConfigAsync(schema, { httpClient });

        expect(await cfg.publicConfig.get('fileOnlyKey')).toBe('from-file');
        expect(cfg.getSource('fileOnlyKey')).toBe('file');
        expect(vi.mocked(Logger.prototype.error)).not.toHaveBeenCalled();
    });
});
