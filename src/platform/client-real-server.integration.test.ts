/**
 * Integration tests for ConfigClient using a real HTTP server (not MSW).
 *
 * Tests SDK initialization from env vars, real HTTP transport, cache behavior,
 * error recovery, and environment isolation.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigClient } from './client';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------
const API_KEY = 'real-server-test-key';
const ORG_ID = 'org-real-test-001';
let BASE_URL: string;

// ---------------------------------------------------------------------------
// Mock data for the real server
// ---------------------------------------------------------------------------
const SERVER_DATA: Record<string, Record<string, unknown>> = {
    production: {
        API_URL: 'https://api.prod.example.com',
        MAX_RETRIES: 3,
        DEBUG: false,
        NESTED: { a: { b: { c: 'deep' } } },
        DB_SECRET: 'prod-secret-123',
    },
    staging: {
        API_URL: 'https://api.staging.example.com',
        MAX_RETRIES: 5,
        DEBUG: true,
    },
    development: {
        API_URL: 'http://localhost:3000',
        MAX_RETRIES: 10,
        DEBUG: true,
    },
};

// ---------------------------------------------------------------------------
// Real HTTP server
// ---------------------------------------------------------------------------
let server: Server;
let requestCount = 0;

function resetRequestCount() {
    requestCount = 0;
}

function createTestServer(): Promise<Server> {
    return new Promise((resolve) => {
        const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
            requestCount++;

            // Auth check
            const auth = req.headers.authorization;
            if (auth !== `Bearer ${API_KEY}`) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
            }

            const url = new URL(req.url!, `http://${req.headers.host}`);
            const pathParts = url.pathname.split('/').filter(Boolean);

            // Org check
            if (pathParts[0] !== 'organizations' || pathParts[1] !== ORG_ID) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Forbidden' }));
                return;
            }

            const env = url.searchParams.get('environment') || 'development';

            // GET /organizations/:orgId/config/values/:key
            if (pathParts[2] === 'config' && pathParts[3] === 'values' && pathParts[4]) {
                const key = decodeURIComponent(pathParts[4]);
                const envValues = SERVER_DATA[env];
                if (!envValues || !(key in envValues)) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `Key "${key}" not found` }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ value: envValues[key] }));
                return;
            }

            // GET /organizations/:orgId/config/values
            if (pathParts[2] === 'config' && pathParts[3] === 'values' && !pathParts[4]) {
                const envValues = SERVER_DATA[env] ?? {};
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ values: envValues }));
                return;
            }

            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not Found' }));
        });

        srv.listen(0, '127.0.0.1', () => {
            resolve(srv);
        });
    });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeAll(async () => {
    server = await createTestServer();
    const address = server.address() as { port: number };
    BASE_URL = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
    resetRequestCount();
});

function createClient(overrides: Partial<{ baseUrl: string; apiKey: string; orgId: string; environment: string; cacheTtlMs: number }> = {}) {
    return new ConfigClient({
        baseUrl: overrides.baseUrl ?? BASE_URL,
        apiKey: overrides.apiKey ?? API_KEY,
        orgId: overrides.orgId ?? ORG_ID,
        environment: overrides.environment,
        cacheTtlMs: overrides.cacheTtlMs,
    });
}

// ===========================================================================
// Tests
// ===========================================================================

describe('ConfigClient with Real HTTP Server', () => {
    describe('Basic value retrieval', () => {
        it('fetches a string value over real HTTP', async () => {
            const client = createClient();
            const value = await client.getValue('API_URL', 'production');
            expect(value).toBe('https://api.prod.example.com');
        });

        it('fetches a number value', async () => {
            const client = createClient();
            const value = await client.getValue('MAX_RETRIES', 'production');
            expect(value).toBe(3);
        });

        it('fetches a boolean value', async () => {
            const client = createClient();
            const value = await client.getValue('DEBUG', 'production');
            expect(value).toBe(false);
        });

        it('fetches a deeply nested object', async () => {
            const client = createClient();
            const value = await client.getValue('NESTED', 'production');
            expect(value).toEqual({ a: { b: { c: 'deep' } } });
        });

        it('uses default environment', async () => {
            const client = createClient({ environment: 'production' });
            const value = await client.getValue('API_URL');
            expect(value).toBe('https://api.prod.example.com');
        });

        it('defaults to development environment', async () => {
            const client = createClient();
            const value = await client.getValue('API_URL');
            expect(value).toBe('http://localhost:3000');
        });
    });

    describe('getAllValues over real HTTP', () => {
        it('fetches all values for an environment', async () => {
            const client = createClient();
            const values = await client.getAllValues('production');
            expect(values.API_URL).toBe('https://api.prod.example.com');
            expect(values.MAX_RETRIES).toBe(3);
            expect(values.DEBUG).toBe(false);
            expect(values.DB_SECRET).toBe('prod-secret-123');
        });

        it('returns empty object for unknown environment', async () => {
            const client = createClient();
            const values = await client.getAllValues('nonexistent');
            expect(values).toEqual({});
        });
    });

    describe('Caching with real HTTP', () => {
        it('caches getValue — only one request for repeated calls', async () => {
            const client = createClient();

            await client.getValue('API_URL', 'production');
            expect(requestCount).toBe(1);

            await client.getValue('API_URL', 'production');
            expect(requestCount).toBe(1);
        });

        it('getAllValues populates cache for subsequent getValue', async () => {
            const client = createClient();

            await client.getAllValues('production');
            expect(requestCount).toBe(1);

            const url = await client.getValue('API_URL', 'production');
            const retries = await client.getValue('MAX_RETRIES', 'production');
            expect(requestCount).toBe(1); // All from cache
            expect(url).toBe('https://api.prod.example.com');
            expect(retries).toBe(3);
        });

        it('invalidateCache forces re-fetch', async () => {
            const client = createClient();

            await client.getValue('API_URL', 'production');
            expect(requestCount).toBe(1);

            client.invalidateCache();

            await client.getValue('API_URL', 'production');
            expect(requestCount).toBe(2);
        });
    });

    describe('SDK initialization from env vars', () => {
        const savedEnv: Record<string, string | undefined> = {};

        function setEnv(vars: Record<string, string | undefined>) {
            for (const [key, value] of Object.entries(vars)) {
                savedEnv[key] = process.env[key];
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        }

        afterEach(() => {
            for (const [key, value] of Object.entries(savedEnv)) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        });

        it('constructs from SMOOAI_CONFIG_* env vars', async () => {
            setEnv({
                SMOOAI_CONFIG_API_URL: BASE_URL,
                SMOOAI_CONFIG_API_KEY: API_KEY,
                SMOOAI_CONFIG_ORG_ID: ORG_ID,
                SMOOAI_CONFIG_ENV: 'production',
            });

            const client = new ConfigClient();
            const value = await client.getValue('API_URL');
            expect(value).toBe('https://api.prod.example.com');
        });

        it('constructor args override env vars', async () => {
            setEnv({
                SMOOAI_CONFIG_API_URL: 'http://wrong-url.example.com',
                SMOOAI_CONFIG_API_KEY: 'wrong-key',
                SMOOAI_CONFIG_ORG_ID: 'wrong-org',
            });

            const client = new ConfigClient({
                baseUrl: BASE_URL,
                apiKey: API_KEY,
                orgId: ORG_ID,
            });
            const value = await client.getValue('API_URL', 'production');
            expect(value).toBe('https://api.prod.example.com');
        });

        it('throws when required env vars are missing', () => {
            setEnv({
                SMOOAI_CONFIG_API_URL: undefined,
                SMOOAI_CONFIG_API_KEY: undefined,
                SMOOAI_CONFIG_ORG_ID: undefined,
            });

            expect(() => new ConfigClient()).toThrow('baseUrl is required');
        });
    });

    describe('Environment switching and isolation', () => {
        it('caches per environment — switching envs does not cross-contaminate', async () => {
            const client = createClient();

            const prodUrl = await client.getValue('API_URL', 'production');
            const stagingUrl = await client.getValue('API_URL', 'staging');
            const devUrl = await client.getValue('API_URL', 'development');

            expect(prodUrl).toBe('https://api.prod.example.com');
            expect(stagingUrl).toBe('https://api.staging.example.com');
            expect(devUrl).toBe('http://localhost:3000');

            expect(requestCount).toBe(3);

            // All cached now
            await client.getValue('API_URL', 'production');
            await client.getValue('API_URL', 'staging');
            await client.getValue('API_URL', 'development');
            expect(requestCount).toBe(3);
        });

        it('invalidateCacheForEnvironment only clears target env', async () => {
            const client = createClient();

            await client.getValue('API_URL', 'production');
            await client.getValue('API_URL', 'staging');
            expect(requestCount).toBe(2);

            client.invalidateCacheForEnvironment('production');

            // Production re-fetches, staging stays cached
            await client.getValue('API_URL', 'production');
            expect(requestCount).toBe(3);

            await client.getValue('API_URL', 'staging');
            expect(requestCount).toBe(3); // Still cached
        });

        it('getAllValues for one env does not populate another env', async () => {
            const client = createClient();

            await client.getAllValues('production');
            expect(requestCount).toBe(1);

            // Staging needs its own fetch
            await client.getValue('API_URL', 'staging');
            expect(requestCount).toBe(2);
        });
    });

    describe('Error handling with real HTTP', () => {
        it('throws on 401 Unauthorized', async () => {
            const client = createClient({ apiKey: 'wrong-key' });
            await expect(client.getValue('API_URL', 'production')).rejects.toThrow(/HTTP 401/);
        });

        it('throws on 403 Forbidden', async () => {
            const client = createClient({ orgId: 'wrong-org' });
            await expect(client.getValue('API_URL', 'production')).rejects.toThrow(/HTTP 403/);
        });

        it('throws on 404 Not Found for missing key', async () => {
            const client = createClient();
            await expect(client.getValue('NONEXISTENT', 'production')).rejects.toThrow(/HTTP 404/);
        });

        it('handles connection refused gracefully', async () => {
            const client = createClient({ baseUrl: 'http://127.0.0.1:1' });
            await expect(client.getValue('API_URL', 'production')).rejects.toThrow();
        });
    });

    describe('TTL caching with real server', () => {
        it('serves from cache within TTL', async () => {
            const client = createClient({ cacheTtlMs: 60_000 });

            await client.getValue('API_URL', 'production');
            expect(requestCount).toBe(1);

            await client.getValue('API_URL', 'production');
            expect(requestCount).toBe(1);
        });

        it('re-fetches after TTL expires', async () => {
            const originalDateNow = Date.now;
            let fakeTime = originalDateNow.call(Date);
            Date.now = () => fakeTime;

            try {
                const client = createClient({ cacheTtlMs: 100 });

                await client.getValue('API_URL', 'production');
                expect(requestCount).toBe(1);

                // Advance past TTL
                fakeTime += 200;

                await client.getValue('API_URL', 'production');
                expect(requestCount).toBe(2);
            } finally {
                Date.now = originalDateNow;
            }
        });

        it('cache never expires when TTL is 0', async () => {
            const originalDateNow = Date.now;
            let fakeTime = originalDateNow.call(Date);
            Date.now = () => fakeTime;

            try {
                const client = createClient(); // No TTL

                await client.getValue('API_URL', 'production');
                expect(requestCount).toBe(1);

                fakeTime += 86_400_000; // 24 hours

                await client.getValue('API_URL', 'production');
                expect(requestCount).toBe(1);
            } finally {
                Date.now = originalDateNow;
            }
        });
    });

    describe('Full workflow with real server', () => {
        it('getAllValues → getValue (cached) → invalidate → getValue (re-fetch)', async () => {
            const client = createClient();

            const all = await client.getAllValues('production');
            expect(all.API_URL).toBe('https://api.prod.example.com');
            expect(requestCount).toBe(1);

            const cached = await client.getValue('API_URL', 'production');
            expect(cached).toBe('https://api.prod.example.com');
            expect(requestCount).toBe(1);

            client.invalidateCache();

            const fresh = await client.getValue('API_URL', 'production');
            expect(fresh).toBe('https://api.prod.example.com');
            expect(requestCount).toBe(2);
        });

        it('multiple clients share no state', async () => {
            const client1 = createClient();
            const client2 = createClient();

            await client1.getValue('API_URL', 'production');
            expect(requestCount).toBe(1);

            // client2 has its own cache
            await client2.getValue('API_URL', 'production');
            expect(requestCount).toBe(2);

            // Invalidating client1 does not affect client2
            client1.invalidateCache();

            await client2.getValue('API_URL', 'production');
            expect(requestCount).toBe(2); // Still cached in client2
        });
    });
});

describe('ConfigClient Error Recovery', () => {
    let errorServer: Server;
    let errorServerUrl: string;
    let callCount = 0;

    beforeAll(async () => {
        errorServer = await new Promise<Server>((resolve) => {
            const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
                callCount++;

                const auth = req.headers.authorization;
                if (auth !== `Bearer ${API_KEY}`) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }

                // First call returns error, subsequent calls succeed
                if (callCount === 1) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Internal Server Error' }));
                    return;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ value: 'recovered-value' }));
            });

            srv.listen(0, '127.0.0.1', () => resolve(srv));
        });

        const address = errorServer.address() as { port: number };
        errorServerUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => errorServer.close(() => resolve()));
    });

    beforeEach(() => {
        callCount = 0;
    });

    it('recovers after server error on retry', async () => {
        const client = new ConfigClient({
            baseUrl: errorServerUrl,
            apiKey: API_KEY,
            orgId: ORG_ID,
        });

        // First call fails
        await expect(client.getValue('KEY', 'production')).rejects.toThrow(/HTTP 500/);

        // Second call succeeds (server recovered)
        const value = await client.getValue('KEY', 'production');
        expect(value).toBe('recovered-value');
    });

    it('does not cache error responses', async () => {
        const client = new ConfigClient({
            baseUrl: errorServerUrl,
            apiKey: API_KEY,
            orgId: ORG_ID,
        });

        // Fails
        await expect(client.getValue('KEY', 'production')).rejects.toThrow();

        // Retries and succeeds — was NOT cached from the error
        const value = await client.getValue('KEY', 'production');
        expect(value).toBe('recovered-value');
        expect(callCount).toBe(2);
    });
});

describe('ConfigClient with Malformed Responses', () => {
    let malformedServer: Server;
    let malformedServerUrl: string;

    beforeAll(async () => {
        malformedServer = await new Promise<Server>((resolve) => {
            const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
                const url = new URL(req.url!, `http://${req.headers.host}`);
                const pathParts = url.pathname.split('/').filter(Boolean);

                if (pathParts[4] === 'malformed-json') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end('not valid json {{{');
                    return;
                }

                if (pathParts[4] === 'empty-response') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end('');
                    return;
                }

                if (pathParts[4] === 'slow-key') {
                    // Simulate a very slow response
                    setTimeout(() => {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ value: 'slow-value' }));
                    }, 50);
                    return;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ value: 'ok' }));
            });

            srv.listen(0, '127.0.0.1', () => resolve(srv));
        });

        const address = malformedServer.address() as { port: number };
        malformedServerUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => malformedServer.close(() => resolve()));
    });

    it('throws on malformed JSON response', async () => {
        const client = new ConfigClient({
            baseUrl: malformedServerUrl,
            apiKey: 'any',
            orgId: 'any',
        });

        await expect(client.getValue('malformed-json', 'production')).rejects.toThrow();
    });

    it('throws on empty response body', async () => {
        const client = new ConfigClient({
            baseUrl: malformedServerUrl,
            apiKey: 'any',
            orgId: 'any',
        });

        await expect(client.getValue('empty-response', 'production')).rejects.toThrow();
    });

    it('handles slow responses without breaking', async () => {
        const client = new ConfigClient({
            baseUrl: malformedServerUrl,
            apiKey: 'any',
            orgId: 'any',
        });

        const value = await client.getValue('slow-key', 'production');
        expect(value).toBe('slow-value');
    });
});
