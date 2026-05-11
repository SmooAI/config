import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetBootstrapCacheForTests, bootstrapFetch } from '../index';

// Snapshot + restore process.env for full test isolation.
const originalEnv = { ...process.env };

function clearSmooEnv() {
    for (const key of Object.keys(process.env)) {
        if (key.startsWith('SMOOAI_') || key.startsWith('SST_') || key === 'NEXT_PUBLIC_SST_STAGE') {
            delete process.env[key];
        }
    }
}

function setBaseEnv() {
    process.env.SMOOAI_CONFIG_API_URL = 'https://api.example.test';
    process.env.SMOOAI_CONFIG_AUTH_URL = 'https://auth.example.test';
    process.env.SMOOAI_CONFIG_CLIENT_ID = 'client-id-123';
    process.env.SMOOAI_CONFIG_CLIENT_SECRET = 'client-secret-456';
    process.env.SMOOAI_CONFIG_ORG_ID = 'org-789';
}

type FetchArgs = [input: string | URL, init?: RequestInit];

function mockFetchResponses(responses: Array<{ ok?: boolean; status?: number; body: unknown; text?: string }>) {
    const fetchMock = vi.fn(async (..._args: FetchArgs) => {
        const next = responses.shift();
        if (!next) throw new Error('mock fetch ran out of queued responses');
        const ok = next.ok ?? true;
        const status = next.status ?? (ok ? 200 : 500);
        return {
            ok,
            status,
            json: async () => next.body,
            text: async () => next.text ?? JSON.stringify(next.body),
        } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

describe('bootstrapFetch', () => {
    beforeEach(() => {
        clearSmooEnv();
        resetBootstrapCacheForTests();
        setBaseEnv();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        // restore env
        for (const key of Object.keys(process.env)) {
            if (!(key in originalEnv)) delete process.env[key];
        }
        for (const [k, v] of Object.entries(originalEnv)) {
            process.env[k] = v;
        }
    });

    it('returns the value for a known key', async () => {
        const fetchMock = mockFetchResponses([{ body: { access_token: 'TOKEN' } }, { body: { values: { databaseUrl: 'postgres://example' } } }]);

        const value = await bootstrapFetch('databaseUrl');
        expect(value).toBe('postgres://example');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('returns undefined for a missing key without throwing', async () => {
        mockFetchResponses([{ body: { access_token: 'TOKEN' } }, { body: { values: { otherKey: 'x' } } }]);

        const value = await bootstrapFetch('databaseUrl');
        expect(value).toBeUndefined();
    });

    it('caches the values map per env across calls', async () => {
        const fetchMock = mockFetchResponses([{ body: { access_token: 'TOKEN' } }, { body: { values: { a: '1', b: '2' } } }]);

        const a = await bootstrapFetch('a');
        const b = await bootstrapFetch('b');
        expect(a).toBe('1');
        expect(b).toBe('2');
        // Only 2 HTTP calls total (token + values), not 4.
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('re-fetches when the resolved env changes', async () => {
        const fetchMock = mockFetchResponses([
            { body: { access_token: 'T1' } },
            { body: { values: { a: 'dev' } } },
            { body: { access_token: 'T2' } },
            { body: { values: { a: 'prod' } } },
        ]);

        const a1 = await bootstrapFetch('a', { environment: 'development' });
        const a2 = await bootstrapFetch('a', { environment: 'production' });
        expect(a1).toBe('dev');
        expect(a2).toBe('prod');
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('sends OAuth client_credentials with the expected body', async () => {
        const fetchMock = mockFetchResponses([{ body: { access_token: 'TOKEN' } }, { body: { values: { k: 'v' } } }]);
        await bootstrapFetch('k');

        const [authUrl, authInit] = fetchMock.mock.calls[0]!;
        expect(authUrl).toBe('https://auth.example.test/token');
        expect(authInit!.method).toBe('POST');
        const body = String(authInit!.body);
        expect(body).toContain('grant_type=client_credentials');
        expect(body).toContain('client_id=client-id-123');
        expect(body).toContain('client_secret=client-secret-456');
        expect(body).toContain('provider=client_credentials');
    });

    it('sends the values GET with bearer token and url-encoded environment', async () => {
        const fetchMock = mockFetchResponses([{ body: { access_token: 'TOKEN' } }, { body: { values: { k: 'v' } } }]);
        await bootstrapFetch('k', { environment: 'staging env' });

        const [valuesUrl, valuesInit] = fetchMock.mock.calls[1]!;
        expect(valuesUrl).toBe('https://api.example.test/organizations/org-789/config/values?environment=staging%20env');
        const headers = valuesInit!.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer TOKEN');
    });

    it('throws when required env vars are missing', async () => {
        delete process.env.SMOOAI_CONFIG_CLIENT_ID;
        await expect(bootstrapFetch('k')).rejects.toThrow(/SMOOAI_CONFIG_\{CLIENT_ID,CLIENT_SECRET,ORG_ID\}/);
    });

    it('accepts legacy SMOOAI_CONFIG_API_KEY as client secret', async () => {
        delete process.env.SMOOAI_CONFIG_CLIENT_SECRET;
        process.env.SMOOAI_CONFIG_API_KEY = 'legacy-secret';
        const fetchMock = mockFetchResponses([{ body: { access_token: 'TOKEN' } }, { body: { values: { k: 'v' } } }]);
        const value = await bootstrapFetch('k');
        expect(value).toBe('v');
        const body = String(fetchMock.mock.calls[0]![1]!.body);
        expect(body).toContain('client_secret=legacy-secret');
    });

    it('accepts legacy SMOOAI_AUTH_URL when SMOOAI_CONFIG_AUTH_URL absent', async () => {
        delete process.env.SMOOAI_CONFIG_AUTH_URL;
        process.env.SMOOAI_AUTH_URL = 'https://legacy-auth.example.test';
        const fetchMock = mockFetchResponses([{ body: { access_token: 'TOKEN' } }, { body: { values: { k: 'v' } } }]);
        await bootstrapFetch('k');
        expect(fetchMock.mock.calls[0]![0]).toBe('https://legacy-auth.example.test/token');
    });

    it('throws a clear error when the OAuth call fails', async () => {
        mockFetchResponses([{ ok: false, status: 401, body: {}, text: 'invalid_client' }]);
        await expect(bootstrapFetch('k')).rejects.toThrow(/OAuth token exchange failed: HTTP 401 invalid_client/);
    });

    it('throws a clear error when the values call fails', async () => {
        mockFetchResponses([{ body: { access_token: 'TOKEN' } }, { ok: false, status: 500, body: {}, text: 'boom' }]);
        await expect(bootstrapFetch('k')).rejects.toThrow(/GET \/config\/values failed: HTTP 500 boom/);
    });

    it('throws when the OAuth response is missing access_token', async () => {
        mockFetchResponses([{ body: {} }]);
        await expect(bootstrapFetch('k')).rejects.toThrow(/no access_token/);
    });

    describe('environment resolution', () => {
        it('uses explicit options.environment first', async () => {
            const fetchMock = mockFetchResponses([{ body: { access_token: 'T' } }, { body: { values: {} } }]);
            process.env.SST_STAGE = 'should-be-ignored';
            await bootstrapFetch('k', { environment: 'explicit-env' });
            expect(fetchMock.mock.calls[1]![0]).toContain('environment=explicit-env');
        });

        it('uses SST_STAGE when no explicit env', async () => {
            process.env.SST_STAGE = 'brentrager';
            const fetchMock = mockFetchResponses([{ body: { access_token: 'T' } }, { body: { values: {} } }]);
            await bootstrapFetch('k');
            expect(fetchMock.mock.calls[1]![0]).toContain('environment=brentrager');
        });

        it('uses NEXT_PUBLIC_SST_STAGE as a fallback for stage', async () => {
            process.env.NEXT_PUBLIC_SST_STAGE = 'dev-stage';
            const fetchMock = mockFetchResponses([{ body: { access_token: 'T' } }, { body: { values: {} } }]);
            await bootstrapFetch('k');
            expect(fetchMock.mock.calls[1]![0]).toContain('environment=dev-stage');
        });

        it('parses SST_RESOURCE_App JSON for stage', async () => {
            process.env.SST_RESOURCE_App = JSON.stringify({ stage: 'sst-resource-stage' });
            const fetchMock = mockFetchResponses([{ body: { access_token: 'T' } }, { body: { values: {} } }]);
            await bootstrapFetch('k');
            expect(fetchMock.mock.calls[1]![0]).toContain('environment=sst-resource-stage');
        });

        it('maps stage=production to environment=production', async () => {
            process.env.SST_STAGE = 'production';
            const fetchMock = mockFetchResponses([{ body: { access_token: 'T' } }, { body: { values: {} } }]);
            await bootstrapFetch('k');
            expect(fetchMock.mock.calls[1]![0]).toContain('environment=production');
        });

        it('uses SMOOAI_CONFIG_ENV when no stage env vars are set', async () => {
            process.env.SMOOAI_CONFIG_ENV = 'qa';
            const fetchMock = mockFetchResponses([{ body: { access_token: 'T' } }, { body: { values: {} } }]);
            await bootstrapFetch('k');
            expect(fetchMock.mock.calls[1]![0]).toContain('environment=qa');
        });

        it('falls back to development as the last resort', async () => {
            const fetchMock = mockFetchResponses([{ body: { access_token: 'T' } }, { body: { values: {} } }]);
            await bootstrapFetch('k');
            expect(fetchMock.mock.calls[1]![0]).toContain('environment=development');
        });

        it('survives malformed SST_RESOURCE_App JSON', async () => {
            process.env.SST_RESOURCE_App = '{not json';
            process.env.SMOOAI_CONFIG_ENV = 'qa';
            const fetchMock = mockFetchResponses([{ body: { access_token: 'T' } }, { body: { values: {} } }]);
            await bootstrapFetch('k');
            expect(fetchMock.mock.calls[1]![0]).toContain('environment=qa');
        });
    });

    it('stringifies non-string values', async () => {
        mockFetchResponses([{ body: { access_token: 'T' } }, { body: { values: { count: 42, flag: true } } }]);
        expect(await bootstrapFetch('count')).toBe('42');
        // cache hit, no new mocks needed
        expect(await bootstrapFetch('flag')).toBe('true');
    });
});
