import { CliApiClient } from '@/cli/utils/api-client';
import type { Credentials, OAuthCredentials } from '@/cli/utils/credentials';
/**
 * SMOODEV-643: end-to-end OAuth flow test.
 *
 * Verifies that `CliApiClient` transparently exchanges client credentials for
 * an access token, uses it on API calls, refreshes it when it's about to
 * expire, and persists refreshed tokens through the `onCredentialsChange`
 * callback so disk storage stays up to date.
 */
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const API_URL = 'https://api.smooai.test';
const AUTH_URL = 'https://auth.smooai.test';
const ORG_ID = '550e8400-e29b-41d4-a716-446655440000';
const CLIENT_ID = 'cid-uuid';
const CLIENT_SECRET = 'sk_super_secret';

let tokenCounter = 0;
let tokenExchangeCount = 0;
let lastUsedBearer: string | null = null;

const handlers = [
    http.post(`${AUTH_URL}/token`, async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        if (body.get('client_id') !== CLIENT_ID || body.get('client_secret') !== CLIENT_SECRET) {
            return HttpResponse.json({ error: 'invalid_client' }, { status: 401 });
        }
        if (body.get('provider') !== 'client_credentials') {
            return HttpResponse.json({ error: 'missing provider' }, { status: 400 });
        }
        tokenExchangeCount += 1;
        tokenCounter += 1;
        return HttpResponse.json({
            access_token: `token-${tokenCounter}`,
            token_type: 'Bearer',
            expires_in: 3600,
        });
    }),
    http.get(`${API_URL}/organizations/:orgId/config/schemas`, ({ request }) => {
        lastUsedBearer = request.headers.get('Authorization');
        if (!lastUsedBearer?.startsWith('Bearer ')) {
            return HttpResponse.json({ error: 'unauth' }, { status: 401 });
        }
        return HttpResponse.json([]);
    }),
    http.get(`${API_URL}/organizations/:orgId/config/values`, ({ request }) => {
        lastUsedBearer = request.headers.get('Authorization');
        if (!lastUsedBearer?.startsWith('Bearer ')) {
            return HttpResponse.json({ error: 'unauth' }, { status: 401 });
        }
        return HttpResponse.json({ values: { FOO: 'bar' } });
    }),
    http.get(`${API_URL}/organizations/:orgId/config/error-values`, () => HttpResponse.json({ success: false, error: 'schema-not-found' })),
];

const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
beforeEach(() => {
    tokenCounter = 0;
    tokenExchangeCount = 0;
    lastUsedBearer = null;
});
afterEach(() => server.resetHandlers());

function oauthCreds(overrides: Partial<OAuthCredentials> = {}): OAuthCredentials {
    return {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        orgId: ORG_ID,
        baseUrl: API_URL,
        authUrl: AUTH_URL,
        ...overrides,
    };
}

describe('CliApiClient OAuth flow', () => {
    it('exchanges client credentials once, then reuses the token', async () => {
        const persisted: { value: Credentials | null } = { value: null };
        const client = new CliApiClient(oauthCreds(), { onCredentialsChange: (c) => (persisted.value = c) });

        await client.listSchemas();
        await client.listSchemas();

        expect(tokenExchangeCount).toBe(1);
        expect(lastUsedBearer).toBe('Bearer token-1');
        const saved = persisted.value as OAuthCredentials;
        expect(saved.accessToken).toBe('token-1');
        expect(saved.accessTokenExpiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('refreshes when the stored token is within the 60s refresh window', async () => {
        const nowSec = Math.floor(Date.now() / 1000);
        const persisted: { value: Credentials | null } = { value: null };

        const client = new CliApiClient(oauthCreds({ accessToken: 'stale', accessTokenExpiresAt: nowSec + 30 }), {
            onCredentialsChange: (c) => (persisted.value = c),
        });

        await client.listSchemas();
        expect(tokenExchangeCount).toBe(1);
        expect(lastUsedBearer).toBe('Bearer token-1');
        expect((persisted.value as OAuthCredentials).accessToken).toBe('token-1');
    });

    it('skips refresh when token is still fresh', async () => {
        const nowSec = Math.floor(Date.now() / 1000);
        const client = new CliApiClient(oauthCreds({ accessToken: 'fresh-token', accessTokenExpiresAt: nowSec + 3600 }), { onCredentialsChange: () => {} });

        await client.listSchemas();
        expect(tokenExchangeCount).toBe(0);
        expect(lastUsedBearer).toBe('Bearer fresh-token');
    });

    it('surfaces 401 from the token endpoint as a clear error', async () => {
        const client = new CliApiClient(oauthCreds({ clientId: 'wrong', clientSecret: 'wrong' }), { onCredentialsChange: () => {} });
        await expect(client.listSchemas()).rejects.toThrow(/rejected|HTTP 401/i);
    });

    it('getAllValues throws when the server returns { success: false }', async () => {
        // Re-route the /values endpoint to the error variant.
        server.use(http.get(`${API_URL}/organizations/:orgId/config/values`, () => HttpResponse.json({ success: false, error: 'schema not configured' })));

        const nowSec = Math.floor(Date.now() / 1000);
        const client = new CliApiClient(oauthCreds({ accessToken: 'fresh-token', accessTokenExpiresAt: nowSec + 3600 }), { onCredentialsChange: () => {} });

        await expect(client.getAllValues('production')).rejects.toThrow(/schema not configured/);
    });
});
