/**
 * Integration tests for the TypeScript ConfigClient using MSW (Mock Service Worker).
 *
 * These tests verify the client's behavior against a realistic mock of the
 * Smoo AI config API, including authentication, caching, error handling,
 * and environment isolation.
 */
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigClient, type ConfigClientOptions } from './client';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------
const BASE_URL = 'https://config.smooai.test';
const API_KEY = 'test-api-key-12345';
const ORG_ID = '550e8400-e29b-41d4-a716-446655440000';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------
const MOCK_VALUES: Record<string, Record<string, unknown>> = {
    production: {
        API_URL: 'https://api.smooai.com',
        MAX_RETRIES: 3,
        DEBUG: false,
        NESTED_CONFIG: { database: { host: 'db.prod.smooai.com', port: 5432 } },
        FEATURE_DARK_MODE: true,
    },
    staging: {
        API_URL: 'https://api.staging.smooai.com',
        MAX_RETRIES: 5,
        DEBUG: true,
        NESTED_CONFIG: { database: { host: 'db.staging.smooai.com', port: 5432 } },
        FEATURE_DARK_MODE: false,
    },
    development: {
        API_URL: 'http://localhost:3000',
        MAX_RETRIES: 10,
        DEBUG: true,
    },
};

// ---------------------------------------------------------------------------
// Request logging for cache verification
// ---------------------------------------------------------------------------
let requestLog: { method: string; url: string; timestamp: number }[] = [];

function logRequest(method: string, url: string) {
    requestLog.push({ method, url, timestamp: Date.now() });
}

function getRequestCount(pathPattern?: string): number {
    if (!pathPattern) return requestLog.length;
    return requestLog.filter((r) => r.url.includes(pathPattern)).length;
}

// ---------------------------------------------------------------------------
// MSW Handlers
// ---------------------------------------------------------------------------
const handlers = [
    // Single value endpoint: GET /organizations/:orgId/config/values/:key
    http.get(`${BASE_URL}/organizations/:orgId/config/values/:key`, ({ request, params }) => {
        logRequest('GET', request.url);

        // Auth check
        const auth = request.headers.get('Authorization');
        if (auth !== `Bearer ${API_KEY}`) {
            return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Org check
        if (params.orgId !== ORG_ID) {
            return HttpResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const key = params.key as string;
        const url = new URL(request.url);
        const env = url.searchParams.get('environment') || 'development';

        const envValues = MOCK_VALUES[env];
        if (!envValues || !(key in envValues)) {
            return HttpResponse.json({ error: `Key "${key}" not found in environment "${env}"` }, { status: 404 });
        }

        return HttpResponse.json({ value: envValues[key] });
    }),

    // All values endpoint: GET /organizations/:orgId/config/values
    http.get(`${BASE_URL}/organizations/:orgId/config/values`, ({ request, params }) => {
        logRequest('GET', request.url);

        const auth = request.headers.get('Authorization');
        if (auth !== `Bearer ${API_KEY}`) {
            return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        if (params.orgId !== ORG_ID) {
            return HttpResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const url = new URL(request.url);
        const env = url.searchParams.get('environment') || 'development';

        const envValues = MOCK_VALUES[env];
        if (!envValues) {
            return HttpResponse.json({ values: {} });
        }

        return HttpResponse.json({ values: envValues });
    }),
];

const server = setupServer(...handlers);

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
beforeEach(() => {
    requestLog = [];
});
afterEach(() => server.resetHandlers());

function createClient(overrides: Partial<ConfigClientOptions> = {}) {
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

describe('ConfigClient Integration Tests', () => {
    // -----------------------------------------------------------------------
    // getValue
    // -----------------------------------------------------------------------
    describe('getValue', () => {
        it('fetches a string value', async () => {
            const client = createClient();
            const value = await client.getValue('API_URL', 'production');
            expect(value).toBe('https://api.smooai.com');
        });

        it('fetches a numeric value', async () => {
            const client = createClient();
            const value = await client.getValue('MAX_RETRIES', 'production');
            expect(value).toBe(3);
        });

        it('fetches a boolean value', async () => {
            const client = createClient();
            const value = await client.getValue('DEBUG', 'production');
            expect(value).toBe(false);
        });

        it('fetches a complex nested object', async () => {
            const client = createClient();
            const value = await client.getValue('NESTED_CONFIG', 'production');
            expect(value).toEqual({
                database: { host: 'db.prod.smooai.com', port: 5432 },
            });
        });

        it('uses the environment parameter in the request', async () => {
            const client = createClient();
            const prodVal = await client.getValue('API_URL', 'production');
            const stagingVal = await client.getValue('API_URL', 'staging');

            expect(prodVal).toBe('https://api.smooai.com');
            expect(stagingVal).toBe('https://api.staging.smooai.com');
        });

        it('uses the default environment when none specified', async () => {
            const client = createClient({ environment: 'production' });
            const value = await client.getValue('API_URL');
            expect(value).toBe('https://api.smooai.com');
        });

        it('defaults to "development" environment', async () => {
            const client = createClient();
            const value = await client.getValue('API_URL');
            expect(value).toBe('http://localhost:3000');
        });

        it('sends the correct Authorization header', async () => {
            const client = createClient();
            await client.getValue('API_URL', 'production');
            expect(requestLog).toHaveLength(1);
            // If auth were wrong, we'd get a 401 error
        });

        it('URL-encodes keys with special characters', async () => {
            // MSW decodes path params, so verify the mock receives the decoded key
            // and the client properly encodes it in the URL
            server.use(
                http.get(`${BASE_URL}/organizations/:orgId/config/values/:key`, ({ request, params }) => {
                    logRequest('GET', request.url);
                    const auth = request.headers.get('Authorization');
                    if (auth !== `Bearer ${API_KEY}`) {
                        return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
                    }
                    // Verify the raw URL contains the encoded form
                    expect(request.url).toContain('my%2Fspecial%20key');
                    return HttpResponse.json({ value: `found-${params.key}` });
                }),
            );

            const client = createClient();
            const value = await client.getValue('my/special key', 'production');
            // MSW decodes the path param, so params.key = "my/special key"
            expect(value).toBe('found-my/special key');
        });

        it('throws on 401 Unauthorized', async () => {
            const client = createClient({ apiKey: 'bad-key' });
            await expect(client.getValue('API_URL', 'production')).rejects.toThrow('Config API error: HTTP 401');
        });

        it('throws on 403 Forbidden (wrong org)', async () => {
            const client = createClient({ orgId: 'wrong-org-id' });
            await expect(client.getValue('API_URL', 'production')).rejects.toThrow('Config API error: HTTP 403');
        });

        it('throws on 404 Not Found (unknown key)', async () => {
            const client = createClient();
            await expect(client.getValue('NONEXISTENT_KEY', 'production')).rejects.toThrow('Config API error: HTTP 404');
        });
    });

    // -----------------------------------------------------------------------
    // getAllValues
    // -----------------------------------------------------------------------
    describe('getAllValues', () => {
        it('fetches all values for an environment', async () => {
            const client = createClient();
            const values = await client.getAllValues('production');

            expect(values).toEqual({
                API_URL: 'https://api.smooai.com',
                MAX_RETRIES: 3,
                DEBUG: false,
                NESTED_CONFIG: { database: { host: 'db.prod.smooai.com', port: 5432 } },
                FEATURE_DARK_MODE: true,
            });
        });

        it('uses default environment when none specified', async () => {
            const client = createClient({ environment: 'staging' });
            const values = await client.getAllValues();

            expect(values).toEqual({
                API_URL: 'https://api.staging.smooai.com',
                MAX_RETRIES: 5,
                DEBUG: true,
                NESTED_CONFIG: { database: { host: 'db.staging.smooai.com', port: 5432 } },
                FEATURE_DARK_MODE: false,
            });
        });

        it('returns empty object for unknown environment', async () => {
            const client = createClient();
            const values = await client.getAllValues('nonexistent');
            expect(values).toEqual({});
        });

        it('throws on 401 Unauthorized', async () => {
            const client = createClient({ apiKey: 'wrong-key' });
            await expect(client.getAllValues('production')).rejects.toThrow('Config API error: HTTP 401');
        });

        it('throws on 403 Forbidden (wrong org)', async () => {
            const client = createClient({ orgId: 'wrong-org' });
            await expect(client.getAllValues('production')).rejects.toThrow('Config API error: HTTP 403');
        });

        it('sends exactly one request', async () => {
            const client = createClient();
            await client.getAllValues('production');
            expect(getRequestCount()).toBe(1);
        });
    });

    // -----------------------------------------------------------------------
    // Caching
    // -----------------------------------------------------------------------
    describe('caching', () => {
        it('caches getValue result — second call hits no server', async () => {
            const client = createClient();

            await client.getValue('API_URL', 'production');
            expect(getRequestCount()).toBe(1);

            await client.getValue('API_URL', 'production');
            expect(getRequestCount()).toBe(1); // No additional request
        });

        it('caches different keys independently', async () => {
            const client = createClient();

            await client.getValue('API_URL', 'production');
            await client.getValue('MAX_RETRIES', 'production');
            expect(getRequestCount()).toBe(2); // Two separate fetches

            // Both should be cached now
            await client.getValue('API_URL', 'production');
            await client.getValue('MAX_RETRIES', 'production');
            expect(getRequestCount()).toBe(2); // No additional fetches
        });

        it('caches per-environment (same key, different env = separate cache entries)', async () => {
            const client = createClient();

            await client.getValue('API_URL', 'production');
            await client.getValue('API_URL', 'staging');
            expect(getRequestCount()).toBe(2);

            // Both should be independently cached
            const prod = await client.getValue('API_URL', 'production');
            const staging = await client.getValue('API_URL', 'staging');
            expect(getRequestCount()).toBe(2); // Still 2 — both from cache

            expect(prod).toBe('https://api.smooai.com');
            expect(staging).toBe('https://api.staging.smooai.com');
        });

        it('getAllValues populates cache for subsequent getValue calls', async () => {
            const client = createClient();

            await client.getAllValues('production');
            expect(getRequestCount()).toBe(1);

            // These should all come from cache
            const apiUrl = await client.getValue('API_URL', 'production');
            const retries = await client.getValue('MAX_RETRIES', 'production');
            const debug = await client.getValue('DEBUG', 'production');
            expect(getRequestCount()).toBe(1); // No additional requests

            expect(apiUrl).toBe('https://api.smooai.com');
            expect(retries).toBe(3);
            expect(debug).toBe(false);
        });

        it('invalidateCache forces re-fetch on next call', async () => {
            const client = createClient();

            await client.getValue('API_URL', 'production');
            expect(getRequestCount()).toBe(1);

            client.invalidateCache();

            await client.getValue('API_URL', 'production');
            expect(getRequestCount()).toBe(2); // Had to fetch again
        });

        it('invalidateCache clears all environments', async () => {
            const client = createClient();

            await client.getValue('API_URL', 'production');
            await client.getValue('API_URL', 'staging');
            expect(getRequestCount()).toBe(2);

            client.invalidateCache();

            await client.getValue('API_URL', 'production');
            await client.getValue('API_URL', 'staging');
            expect(getRequestCount()).toBe(4); // Both re-fetched
        });

        it('getAllValues for one env does not cache another env', async () => {
            const client = createClient();

            await client.getAllValues('production');
            expect(getRequestCount()).toBe(1);

            // Staging values are NOT cached
            await client.getValue('API_URL', 'staging');
            expect(getRequestCount()).toBe(2); // Had to fetch
        });

        it('invalidateCache followed by getAllValues re-populates cache', async () => {
            const client = createClient();

            await client.getAllValues('production');
            expect(getRequestCount()).toBe(1);

            client.invalidateCache();

            await client.getAllValues('production');
            expect(getRequestCount()).toBe(2); // Re-fetched

            // Should be cached again
            await client.getValue('API_URL', 'production');
            expect(getRequestCount()).toBe(2); // From cache
        });
    });

    // -----------------------------------------------------------------------
    // Constructor / Configuration
    // -----------------------------------------------------------------------
    describe('constructor', () => {
        it('throws when baseUrl is missing', () => {
            expect(() => new ConfigClient({ apiKey: API_KEY, orgId: ORG_ID })).toThrow('baseUrl is required');
        });

        it('throws when apiKey is missing', () => {
            expect(() => new ConfigClient({ baseUrl: BASE_URL, orgId: ORG_ID })).toThrow('apiKey is required');
        });

        it('throws when orgId is missing', () => {
            expect(() => new ConfigClient({ baseUrl: BASE_URL, apiKey: API_KEY })).toThrow('orgId is required');
        });

        it('strips trailing slashes from baseUrl', async () => {
            const client = createClient({ baseUrl: `${BASE_URL}/` });
            const value = await client.getValue('API_URL', 'production');
            expect(value).toBe('https://api.smooai.com');
        });
    });

    // -----------------------------------------------------------------------
    // Full workflow tests
    // -----------------------------------------------------------------------
    describe('full workflow', () => {
        it('getAllValues → getValue (cached) → invalidate → getValue (re-fetched)', async () => {
            const client = createClient();

            // 1. Load all values
            const all = await client.getAllValues('production');
            expect(all.API_URL).toBe('https://api.smooai.com');
            expect(getRequestCount()).toBe(1);

            // 2. Individual getValue should be cached
            const cached = await client.getValue('API_URL', 'production');
            expect(cached).toBe('https://api.smooai.com');
            expect(getRequestCount()).toBe(1);

            // 3. Invalidate
            client.invalidateCache();

            // 4. Re-fetch
            const fresh = await client.getValue('API_URL', 'production');
            expect(fresh).toBe('https://api.smooai.com');
            expect(getRequestCount()).toBe(2);
        });

        it('works across multiple environments in sequence', async () => {
            const client = createClient();

            const prodUrl = await client.getValue('API_URL', 'production');
            const stagingUrl = await client.getValue('API_URL', 'staging');
            const devUrl = await client.getValue('API_URL', 'development');

            expect(prodUrl).toBe('https://api.smooai.com');
            expect(stagingUrl).toBe('https://api.staging.smooai.com');
            expect(devUrl).toBe('http://localhost:3000');
            expect(getRequestCount()).toBe(3);

            // All should be cached
            await client.getValue('API_URL', 'production');
            await client.getValue('API_URL', 'staging');
            await client.getValue('API_URL', 'development');
            expect(getRequestCount()).toBe(3); // No new requests
        });
    });

    // -----------------------------------------------------------------------
    // TTL (time-to-live) caching
    // -----------------------------------------------------------------------
    describe('TTL caching', () => {
        it('serves from cache within TTL window', async () => {
            const client = createClient({ cacheTtlMs: 60_000 }); // 60s TTL

            await client.getValue('API_URL', 'production');
            expect(getRequestCount()).toBe(1);

            // Should still be cached
            await client.getValue('API_URL', 'production');
            expect(getRequestCount()).toBe(1);
        });

        it('re-fetches after TTL expires', async () => {
            // Use a very short TTL that we can simulate by manipulating Date.now
            const originalDateNow = Date.now;
            let fakeTime = originalDateNow.call(Date);

            // Override Date.now to control time
            Date.now = () => fakeTime;

            try {
                const client = createClient({ cacheTtlMs: 100 }); // 100ms TTL

                await client.getValue('API_URL', 'production');
                expect(getRequestCount()).toBe(1);

                // Still within TTL
                await client.getValue('API_URL', 'production');
                expect(getRequestCount()).toBe(1);

                // Advance time past TTL
                fakeTime += 200;

                await client.getValue('API_URL', 'production');
                expect(getRequestCount()).toBe(2); // Cache expired, re-fetched
            } finally {
                Date.now = originalDateNow;
            }
        });

        it('getAllValues respects TTL', async () => {
            const originalDateNow = Date.now;
            let fakeTime = originalDateNow.call(Date);
            Date.now = () => fakeTime;

            try {
                const client = createClient({ cacheTtlMs: 100 });

                await client.getAllValues('production');
                expect(getRequestCount()).toBe(1);

                // Cached
                await client.getValue('API_URL', 'production');
                expect(getRequestCount()).toBe(1);

                // Expire
                fakeTime += 200;

                await client.getValue('API_URL', 'production');
                expect(getRequestCount()).toBe(2); // Re-fetched
            } finally {
                Date.now = originalDateNow;
            }
        });

        it('no TTL means cache never expires', async () => {
            const originalDateNow = Date.now;
            let fakeTime = originalDateNow.call(Date);
            Date.now = () => fakeTime;

            try {
                const client = createClient(); // No TTL

                await client.getValue('API_URL', 'production');
                expect(getRequestCount()).toBe(1);

                // Advance time significantly
                fakeTime += 86_400_000; // 24 hours

                await client.getValue('API_URL', 'production');
                expect(getRequestCount()).toBe(1); // Still cached
            } finally {
                Date.now = originalDateNow;
            }
        });
    });

    // -----------------------------------------------------------------------
    // Environment-specific cache invalidation
    // -----------------------------------------------------------------------
    describe('invalidateCacheForEnvironment', () => {
        it('clears only the target environment', async () => {
            const client = createClient();

            await client.getValue('API_URL', 'production');
            await client.getValue('API_URL', 'staging');
            expect(getRequestCount()).toBe(2);

            client.invalidateCacheForEnvironment('production');

            // Production re-fetched, staging still cached
            await client.getValue('API_URL', 'production');
            expect(getRequestCount()).toBe(3);

            await client.getValue('API_URL', 'staging');
            expect(getRequestCount()).toBe(3); // Still cached
        });

        it('clears all keys for the environment', async () => {
            const client = createClient();

            await client.getAllValues('production');
            expect(getRequestCount()).toBe(1);

            client.invalidateCacheForEnvironment('production');

            // All production keys need re-fetch
            await client.getValue('API_URL', 'production');
            await client.getValue('MAX_RETRIES', 'production');
            expect(getRequestCount()).toBe(3);
        });

        it('does nothing for non-existent environment', async () => {
            const client = createClient();

            await client.getValue('API_URL', 'production');
            expect(getRequestCount()).toBe(1);

            client.invalidateCacheForEnvironment('nonexistent');

            await client.getValue('API_URL', 'production');
            expect(getRequestCount()).toBe(1); // Still cached
        });
    });
});
