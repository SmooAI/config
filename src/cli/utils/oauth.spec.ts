import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { exchangeClientCredentials, shouldRefreshToken } from './oauth';

const AUTH_URL = 'https://auth.smoo.test';

describe('shouldRefreshToken', () => {
    it('returns true when expiresAt is undefined', () => {
        expect(shouldRefreshToken(undefined)).toBe(true);
    });

    it('returns true inside the refresh window', () => {
        const nowSec = Math.floor(Date.now() / 1000);
        expect(shouldRefreshToken(nowSec + 30, 60)).toBe(true);
    });

    it('returns false outside the refresh window', () => {
        const nowSec = Math.floor(Date.now() / 1000);
        expect(shouldRefreshToken(nowSec + 600, 60)).toBe(false);
    });
});

describe('exchangeClientCredentials', () => {
    const handlers = [
        http.post(`${AUTH_URL}/token`, async ({ request }) => {
            expect(request.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
            const bodyText = await request.text();
            const body = new URLSearchParams(bodyText);
            expect(body.get('grant_type')).toBe('client_credentials');
            expect(body.get('provider')).toBe('client_credentials');

            const clientId = body.get('client_id');
            const clientSecret = body.get('client_secret');

            if (clientId === 'happy' && clientSecret === 'sk_happy') {
                return HttpResponse.json({ access_token: 'eyJ.happy', token_type: 'Bearer', expires_in: 3600 });
            }
            if (clientId === 'bad') {
                return HttpResponse.json({ error: 'invalid_client' }, { status: 401 });
            }
            if (clientId === 'servererror') {
                return HttpResponse.json({ error: 'boom' }, { status: 500 });
            }
            if (clientId === 'malformed') {
                return HttpResponse.json({ foo: 'bar' });
            }
            return HttpResponse.json({ error: 'unexpected' }, { status: 400 });
        }),
    ];
    const server = setupServer(...handlers);

    beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
    afterAll(() => server.close());
    afterEach(() => server.resetHandlers());

    it('returns an access token on 200', async () => {
        const result = await exchangeClientCredentials({
            authUrl: AUTH_URL,
            clientId: 'happy',
            clientSecret: 'sk_happy',
        });
        expect(result.accessToken).toBe('eyJ.happy');
        expect(result.tokenType).toBe('Bearer');
        expect(result.expiresIn).toBe(3600);
        expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('throws with a helpful hint on 401', async () => {
        await expect(exchangeClientCredentials({ authUrl: AUTH_URL, clientId: 'bad', clientSecret: 'sk_bad' })).rejects.toThrow(/rejected.*HTTP 401/i);
    });

    it('throws with raw status on 5xx', async () => {
        await expect(exchangeClientCredentials({ authUrl: AUTH_URL, clientId: 'servererror', clientSecret: 'sk_x' })).rejects.toThrow(/HTTP 500/i);
    });

    it('throws when the response is missing access_token', async () => {
        await expect(exchangeClientCredentials({ authUrl: AUTH_URL, clientId: 'malformed', clientSecret: 'sk_x' })).rejects.toThrow(/malformed/i);
    });

    it('strips trailing slashes on authUrl', async () => {
        const result = await exchangeClientCredentials({
            authUrl: `${AUTH_URL}/`,
            clientId: 'happy',
            clientSecret: 'sk_happy',
        });
        expect(result.accessToken).toBe('eyJ.happy');
    });
});
