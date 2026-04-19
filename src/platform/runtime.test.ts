import crypto from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRuntimeCaches, buildConfigRuntime, hydrateConfigClient, readBakedConfig } from './runtime';

/**
 * Runtime helper tests — matches the Python parity tests in
 * `python/tests/test_runtime.py`. Both languages emit the same blob layout
 * (nonce(12) || ciphertext || authTag(16)) so these tests exercise the
 * decrypt side end-to-end without needing the baker module.
 */

const SAMPLE = {
    public: { apiUrl: 'https://api.example.com', webUrl: 'https://example.com' },
    secret: { tavilyApiKey: 'tvly-abc123', openaiApiKey: 'sk-secret' },
};

function encryptSample(dir: string): { keyB64: string; blobPath: string } {
    const key = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const plaintext = Buffer.from(JSON.stringify(SAMPLE), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const blob = Buffer.concat([nonce, ciphertext, authTag]);

    const blobPath = join(dir, 'smoo-config.enc');
    writeFileSync(blobPath, blob);
    return { keyB64: key.toString('base64'), blobPath };
}

describe('runtime', () => {
    let tmpDir: string;
    const originalEnv = { ...process.env };

    beforeEach(() => {
        tmpDir = join(tmpdir(), `smoo-config-test-${crypto.randomBytes(8).toString('hex')}`);
        mkdirSync(tmpDir, { recursive: true });
        __resetRuntimeCaches();
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
        process.env = { ...originalEnv };
        __resetRuntimeCaches();
        vi.restoreAllMocks();
    });

    describe('readBakedConfig', () => {
        it('returns undefined when env vars are absent', () => {
            delete process.env.SMOO_CONFIG_KEY_FILE;
            delete process.env.SMOO_CONFIG_KEY;
            expect(readBakedConfig()).toBeUndefined();
        });

        it('decrypts and returns the blob when env vars are set', () => {
            const { keyB64, blobPath } = encryptSample(tmpDir);
            process.env.SMOO_CONFIG_KEY_FILE = blobPath;
            process.env.SMOO_CONFIG_KEY = keyB64;

            const blob = readBakedConfig();
            expect(blob).toBeDefined();
            expect(blob!.public.apiUrl).toBe('https://api.example.com');
            expect(blob!.secret.tavilyApiKey).toBe('tvly-abc123');
        });

        it('caches the decrypted blob across calls', () => {
            const { keyB64, blobPath } = encryptSample(tmpDir);
            process.env.SMOO_CONFIG_KEY_FILE = blobPath;
            process.env.SMOO_CONFIG_KEY = keyB64;

            const a = readBakedConfig();
            const b = readBakedConfig();
            expect(a).toBe(b);
        });

        it('throws on wrong-length key', () => {
            const { blobPath } = encryptSample(tmpDir);
            process.env.SMOO_CONFIG_KEY_FILE = blobPath;
            process.env.SMOO_CONFIG_KEY = Buffer.alloc(16).toString('base64'); // 16 bytes, AES-256 wants 32

            expect(() => readBakedConfig()).toThrow(/32 bytes/);
        });

        it('throws on a corrupted blob', () => {
            const { keyB64 } = encryptSample(tmpDir);
            const corrupt = join(tmpDir, 'bad.enc');
            writeFileSync(corrupt, Buffer.alloc(10)); // shorter than minimum (28 bytes)
            process.env.SMOO_CONFIG_KEY_FILE = corrupt;
            process.env.SMOO_CONFIG_KEY = keyB64;

            expect(() => readBakedConfig()).toThrow(/too short/);
        });
    });

    describe('hydrateConfigClient', () => {
        it('seeds the client cache with public + secret values', () => {
            const { keyB64, blobPath } = encryptSample(tmpDir);
            process.env.SMOO_CONFIG_KEY_FILE = blobPath;
            process.env.SMOO_CONFIG_KEY = keyB64;

            const seedSpy = vi.fn();
            const fakeClient = { seedCacheFromMap: seedSpy } as any;

            const seeded = hydrateConfigClient(fakeClient);
            expect(seeded).toBe(4); // 2 public + 2 secret
            expect(seedSpy).toHaveBeenCalledTimes(1);
            const [seededMap] = seedSpy.mock.calls[0];
            expect(seededMap.apiUrl).toBe('https://api.example.com');
            expect(seededMap.tavilyApiKey).toBe('tvly-abc123');
        });

        it('returns 0 and seeds nothing when no blob is present', () => {
            delete process.env.SMOO_CONFIG_KEY_FILE;
            delete process.env.SMOO_CONFIG_KEY;

            const seedSpy = vi.fn();
            const fakeClient = { seedCacheFromMap: seedSpy } as any;

            expect(hydrateConfigClient(fakeClient)).toBe(0);
            expect(seedSpy).not.toHaveBeenCalled();
        });
    });

    describe('buildConfigRuntime', () => {
        it('exposes typed tier accessors backed by the decrypted blob', async () => {
            const { keyB64, blobPath } = encryptSample(tmpDir);
            process.env.SMOO_CONFIG_KEY_FILE = blobPath;
            process.env.SMOO_CONFIG_KEY = keyB64;

            // Minimal schema shape — we only exercise getPublic/getSecret which
            // read from the blob, so the generics don't need full literal typing.
            const schema = {
                publicConfigSchema: {},
                secretConfigSchema: {},
                featureFlagSchema: {},
                PublicConfigKeys: {},
                SecretConfigKeys: {},
                FeatureFlagKeys: {},
                AllConfigKeys: {},
                serializedAllConfigSchema: undefined as any,
                _configTypeInput: undefined as any,
                _zodOutputTypeWithDeferFunctions: undefined as any,
            } as any;

            const config = buildConfigRuntime(schema) as any;
            await expect(config.getPublicConfig('apiUrl')).resolves.toBe('https://api.example.com');
            await expect(config.getSecretConfig('tavilyApiKey')).resolves.toBe('tvly-abc123');
        });
    });
});
