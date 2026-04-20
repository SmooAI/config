/* eslint-disable @typescript-eslint/no-explicit-any -- schema typing is erased at runtime for these integration fixtures */
/**
 * Integration tests for the unified `@smooai/config/server` priority chain.
 *
 * Mirrors the prod Smoo AI config API shape via msw so the HTTP tier gets
 * exercised end-to-end (auth header, org scoping, 401/500 behavior) without
 * hitting the network. Combines with real blob fixtures on disk + real
 * `process.env` overrides + real `.smooai-config/` defaults, so the full
 * priority chain is covered:
 *
 *   public + secret: blob → env → HTTP → file
 *   feature flag:    HTTP → env → file (no blob)
 *
 * These tests intentionally do not exercise the `getSync` variants — those
 * require the tsup dist/ to be built because synckit spawns a worker process
 * against a compiled entry. See `server.spec.ts` for unit-level sync tests
 * that mock the worker.
 */
import crypto from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BooleanSchema, defineConfig, StringSchema } from '@/config/config';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildConfigAsync, __resetServerCaches } from './internal';

// ---------------------------------------------------------------------------
// Prod-shaped config API constants
// ---------------------------------------------------------------------------
const BASE_URL = 'https://config.smooai.test';
const API_KEY = 'test-api-key-priority-chain';
const ORG_ID = '550e8400-e29b-41d4-a716-446655440000';

// ---------------------------------------------------------------------------
// Test schema — small enough to reason about, covers all three tiers
// ---------------------------------------------------------------------------
const schema = defineConfig({
    publicConfigSchema: {
        apiUrl: StringSchema,
        webUrl: StringSchema,
    },
    secretConfigSchema: {
        sendgridApiKey: StringSchema,
        supabaseServiceKey: StringSchema,
    },
    featureFlagSchema: {
        observability: BooleanSchema,
        betaFeatures: BooleanSchema,
    },
});

// ---------------------------------------------------------------------------
// HTTP tier: msw handlers modeled after the real Smoo AI config API
// ---------------------------------------------------------------------------
type ValuesMap = Record<string, Record<string, unknown>>;

let httpValues: ValuesMap = {};

const handlers = [
    http.get(`${BASE_URL}/organizations/:orgId/config/values/:key`, ({ request, params }) => {
        const auth = request.headers.get('Authorization');
        if (auth !== `Bearer ${API_KEY}`) {
            return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        if (params.orgId !== ORG_ID) {
            return HttpResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
        const key = params.key as string;
        const url = new URL(request.url);
        const env = url.searchParams.get('environment') || 'development';
        const value = httpValues[env]?.[key];
        if (value === undefined) {
            return HttpResponse.json({ error: 'Not found' }, { status: 404 });
        }
        return HttpResponse.json({ value });
    }),
    http.get(`${BASE_URL}/organizations/:orgId/config/values`, ({ request, params }) => {
        const auth = request.headers.get('Authorization');
        if (auth !== `Bearer ${API_KEY}`) {
            return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        if (params.orgId !== ORG_ID) {
            return HttpResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
        const url = new URL(request.url);
        const env = url.searchParams.get('environment') || 'development';
        return HttpResponse.json({ values: httpValues[env] ?? {} });
    }),
];

const server = setupServer(...handlers);

// ---------------------------------------------------------------------------
// Blob tier: real AES-256-GCM fixture the same way the SST baker writes one
// ---------------------------------------------------------------------------
function encryptBlob(dir: string, payload: { public: Record<string, unknown>; secret: Record<string, unknown> }): { keyB64: string; blobPath: string } {
    const key = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const blob = Buffer.concat([nonce, ciphertext, authTag]);
    const blobPath = join(dir, 'smoo-config.enc');
    writeFileSync(blobPath, blob);
    return { keyB64: key.toString('base64'), blobPath };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
let tmpDir: string;
const savedEnv = { ...process.env };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
afterEach(() => {
    server.resetHandlers();
    httpValues = {};
});

beforeEach(() => {
    tmpDir = join(tmpdir(), `smoo-config-priority-${crypto.randomBytes(6).toString('hex')}`);
    mkdirSync(tmpDir, { recursive: true });
    // Reset to baseline — tests opt in to each tier by setting env vars / creating fixtures.
    process.env = { ...savedEnv };
    delete process.env.SMOO_CONFIG_KEY_FILE;
    delete process.env.SMOO_CONFIG_KEY;
    delete process.env.SMOOAI_ENV_CONFIG_DIR;
    delete process.env.API_URL;
    delete process.env.WEB_URL;
    delete process.env.SENDGRID_API_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env.OBSERVABILITY;
    delete process.env.BETA_FEATURES;
    process.env.SMOOAI_CONFIG_API_URL = BASE_URL;
    process.env.SMOOAI_CONFIG_API_KEY = API_KEY;
    process.env.SMOOAI_CONFIG_ORG_ID = ORG_ID;
    process.env.SMOOAI_CONFIG_ENV = 'production';
    __resetServerCaches();
});

afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    process.env = { ...savedEnv };
    __resetServerCaches();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('server priority chain: public + secret', () => {
    it('blob wins over env, HTTP, and file', async () => {
        const { keyB64, blobPath } = encryptBlob(tmpDir, {
            public: { apiUrl: 'https://api.from-blob.example' },
            secret: { sendgridApiKey: 'SG.blob-value' },
        });
        process.env.SMOO_CONFIG_KEY_FILE = blobPath;
        process.env.SMOO_CONFIG_KEY = keyB64;
        process.env.API_URL = 'https://api.from-env.example'; // should be ignored
        process.env.SENDGRID_API_KEY = 'SG.env-value';
        httpValues = { production: { apiUrl: 'https://api.from-http.example', sendgridApiKey: 'SG.http-value' } };

        const cfg = buildConfigAsync(schema);
        expect(await cfg.publicConfig.get('apiUrl')).toBe('https://api.from-blob.example');
        expect(await cfg.secretConfig.get('sendgridApiKey')).toBe('SG.blob-value');
        expect(cfg.getSource('apiUrl')).toBe('blob');
        expect(cfg.getSource('sendgridApiKey')).toBe('blob');
    });

    it('env wins over HTTP and file when blob lacks the key', async () => {
        const { keyB64, blobPath } = encryptBlob(tmpDir, { public: {}, secret: {} });
        process.env.SMOO_CONFIG_KEY_FILE = blobPath;
        process.env.SMOO_CONFIG_KEY = keyB64;
        process.env.API_URL = 'https://api.from-env.example';
        process.env.SENDGRID_API_KEY = 'SG.env-value';
        httpValues = { production: { apiUrl: 'https://api.from-http.example' } };

        const cfg = buildConfigAsync(schema);
        expect(await cfg.publicConfig.get('apiUrl')).toBe('https://api.from-env.example');
        expect(await cfg.secretConfig.get('sendgridApiKey')).toBe('SG.env-value');
        expect(cfg.getSource('apiUrl')).toBe('env');
        expect(cfg.getSource('sendgridApiKey')).toBe('env');
    });

    it('HTTP wins over file when blob and env are absent', async () => {
        httpValues = {
            production: {
                apiUrl: 'https://api.from-http.example',
                sendgridApiKey: 'SG.http-value',
            },
        };

        const cfg = buildConfigAsync(schema);
        expect(await cfg.publicConfig.get('apiUrl')).toBe('https://api.from-http.example');
        expect(await cfg.secretConfig.get('sendgridApiKey')).toBe('SG.http-value');
        expect(cfg.getSource('apiUrl')).toBe('http');
    });

    it('returns undefined when no tier has the key', async () => {
        const cfg = buildConfigAsync(schema);
        expect(await cfg.publicConfig.get('apiUrl')).toBeUndefined();
        expect(await cfg.secretConfig.get('sendgridApiKey')).toBeUndefined();
    });

    it('tolerates HTTP errors and falls through', async () => {
        server.use(http.get(`${BASE_URL}/organizations/:orgId/config/values/:key`, () => HttpResponse.json({ error: 'boom' }, { status: 500 })));
        process.env.API_URL = 'https://api.from-env.example';

        const cfg = buildConfigAsync(schema);
        // HTTP 500 shouldn't swallow the env tier.
        expect(await cfg.publicConfig.get('apiUrl')).toBe('https://api.from-env.example');
    });
});

describe('server priority chain: feature flags', () => {
    it('HTTP wins over env (flags are live-toggleable)', async () => {
        process.env.OBSERVABILITY = 'false';
        httpValues = { production: { observability: true } };

        const cfg = buildConfigAsync(schema);
        expect(await cfg.featureFlag.get('observability')).toBe(true);
        expect(cfg.getSource('observability')).toBe('http');
    });

    it('env wins over file when HTTP fails', async () => {
        server.use(http.get(`${BASE_URL}/organizations/:orgId/config/values/:key`, () => HttpResponse.json({ error: 'down' }, { status: 503 })));
        process.env.OBSERVABILITY = 'true';

        const cfg = buildConfigAsync(schema);
        expect(await cfg.featureFlag.get('observability')).toBe(true);
        expect(cfg.getSource('observability')).toBe('env');
    });

    it('blob is intentionally skipped for flags', async () => {
        // Even if someone baked a flag into the blob by mistake, the chain
        // doesn't consult it. HTTP miss → env miss → file miss → undefined.
        const { keyB64, blobPath } = encryptBlob(tmpDir, { public: {}, secret: { observability: true as any } });
        process.env.SMOO_CONFIG_KEY_FILE = blobPath;
        process.env.SMOO_CONFIG_KEY = keyB64;
        server.use(http.get(`${BASE_URL}/organizations/:orgId/config/values/:key`, () => HttpResponse.json({ error: 'missing' }, { status: 404 })));

        const cfg = buildConfigAsync(schema);
        expect(await cfg.featureFlag.get('observability')).toBeUndefined();
    });
});

describe('caching + invalidation', () => {
    it('memoizes reads until invalidateCaches() drops them', async () => {
        httpValues = { production: { apiUrl: 'https://api.first.example' } };
        const cfg = buildConfigAsync(schema);
        expect(await cfg.publicConfig.get('apiUrl')).toBe('https://api.first.example');

        // Change HTTP mock; cache hides the update.
        httpValues = { production: { apiUrl: 'https://api.second.example' } };
        expect(await cfg.publicConfig.get('apiUrl')).toBe('https://api.first.example');

        cfg.invalidateCaches();
        expect(await cfg.publicConfig.get('apiUrl')).toBe('https://api.second.example');
    });
});
