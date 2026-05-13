import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenProvider } from './TokenProvider';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock('@smooai/fetch', () => ({ default: mockFetch }));

const BASE = {
    authUrl: 'https://auth.example.com',
    clientId: 'client-abc',
    clientSecret: 'secret-xyz',
};

function mockTokenResponse(opts: { token?: string; expiresIn?: number; ok?: boolean; status?: number; body?: string } = {}): void {
    mockFetch.mockResolvedValueOnce({
        ok: opts.ok ?? true,
        status: opts.status ?? 200,
        json: () => Promise.resolve({ access_token: opts.token ?? 'jwt-1', expires_in: opts.expiresIn ?? 3600 }),
        text: () => Promise.resolve(opts.body ?? ''),
    });
}

describe('TokenProvider', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('constructor', () => {
        it('throws when authUrl is missing', () => {
            expect(() => new TokenProvider({ ...BASE, authUrl: '' })).toThrow(/authUrl/);
        });
        it('throws when clientId is missing', () => {
            expect(() => new TokenProvider({ ...BASE, clientId: '' })).toThrow(/clientId/);
        });
        it('throws when clientSecret is missing', () => {
            expect(() => new TokenProvider({ ...BASE, clientSecret: '' })).toThrow(/clientSecret/);
        });
        it('trims trailing slashes from authUrl', async () => {
            const p = new TokenProvider({ ...BASE, authUrl: 'https://auth.example.com///' });
            mockTokenResponse();
            await p.getAccessToken();
            expect(mockFetch).toHaveBeenCalledWith('https://auth.example.com/token', expect.any(Object));
        });
    });

    describe('getAccessToken', () => {
        it('POSTs to /token with client_credentials grant + provider param', async () => {
            const p = new TokenProvider(BASE);
            mockTokenResponse({ token: 'jwt-fresh' });
            const token = await p.getAccessToken();
            expect(token).toBe('jwt-fresh');
            expect(mockFetch).toHaveBeenCalledTimes(1);
            const [url, init] = mockFetch.mock.calls[0];
            expect(url).toBe('https://auth.example.com/token');
            expect(init.method).toBe('POST');
            expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
            const body = new URLSearchParams(init.body);
            expect(body.get('grant_type')).toBe('client_credentials');
            expect(body.get('provider')).toBe('client_credentials');
            expect(body.get('client_id')).toBe('client-abc');
            expect(body.get('client_secret')).toBe('secret-xyz');
        });

        it('caches the token and reuses it across calls', async () => {
            const p = new TokenProvider(BASE);
            mockTokenResponse({ token: 'jwt-1', expiresIn: 3600 });
            const t1 = await p.getAccessToken();
            const t2 = await p.getAccessToken();
            expect(t1).toBe('jwt-1');
            expect(t2).toBe('jwt-1');
            expect(mockFetch).toHaveBeenCalledTimes(1); // cached
        });

        it('refreshes when within the refresh window of expiry', async () => {
            const p = new TokenProvider({ ...BASE, refreshWindowSec: 60 });
            // Time t=0, token expires in 100s. Should be valid for first 40s, then refresh.
            let nowMs = 0;
            p._setNowForTests(() => nowMs);
            mockTokenResponse({ token: 'jwt-1', expiresIn: 100 });
            expect(await p.getAccessToken()).toBe('jwt-1');
            // Advance 30s — still valid (refresh window is 60s before expiry; t=30 < 40 threshold)
            nowMs = 30_000;
            expect(await p.getAccessToken()).toBe('jwt-1');
            expect(mockFetch).toHaveBeenCalledTimes(1);
            // Advance to 45s — within refresh window (refresh threshold is t=40, since expiry=100s and window=60s)
            nowMs = 45_000;
            mockTokenResponse({ token: 'jwt-2', expiresIn: 100 });
            expect(await p.getAccessToken()).toBe('jwt-2');
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        it('dedupes concurrent refresh calls (single-flight)', async () => {
            const p = new TokenProvider(BASE);
            let resolveFetch!: (v: unknown) => void;
            mockFetch.mockReturnValueOnce(
                new Promise((res) => {
                    resolveFetch = res;
                }),
            );
            const t1 = p.getAccessToken();
            const t2 = p.getAccessToken();
            const t3 = p.getAccessToken();
            expect(mockFetch).toHaveBeenCalledTimes(1);
            resolveFetch({
                ok: true,
                json: () => Promise.resolve({ access_token: 'jwt-shared', expires_in: 3600 }),
                text: () => Promise.resolve(''),
            });
            expect(await t1).toBe('jwt-shared');
            expect(await t2).toBe('jwt-shared');
            expect(await t3).toBe('jwt-shared');
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it('throws when the token endpoint returns a non-2xx response', async () => {
            const p = new TokenProvider(BASE);
            mockTokenResponse({ ok: false, status: 401, body: 'invalid_client' });
            await expect(p.getAccessToken()).rejects.toThrow(/OAuth token exchange failed: HTTP 401/);
        });

        it('throws when the token endpoint returns no access_token', async () => {
            const p = new TokenProvider(BASE);
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({}),
                text: () => Promise.resolve(''),
            });
            await expect(p.getAccessToken()).rejects.toThrow(/no access_token/);
        });

        it('defaults expires_in to 3600 when missing from the response', async () => {
            const p = new TokenProvider(BASE);
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ access_token: 'jwt-no-expiry' }),
                text: () => Promise.resolve(''),
            });
            expect(await p.getAccessToken()).toBe('jwt-no-expiry');
            // Second call uses cache (would have failed if expires_in defaulted to 0)
            expect(await p.getAccessToken()).toBe('jwt-no-expiry');
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });
    });

    describe('invalidate', () => {
        it('forces a fresh exchange on the next call', async () => {
            const p = new TokenProvider(BASE);
            mockTokenResponse({ token: 'jwt-1' });
            await p.getAccessToken();
            p.invalidate();
            mockTokenResponse({ token: 'jwt-2' });
            expect(await p.getAccessToken()).toBe('jwt-2');
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });
    });
});
