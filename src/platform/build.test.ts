/**
 * SMOODEV-1136: `buildBundle` must persist the environment it baked against
 * into the encrypted blob's plaintext payload so the server SDK can detect
 * env mismatches at read time.
 *
 * Doesn't exercise the full HTTP path — that's covered by
 * `client.integration.test.ts`. Stubs out the network with a fake
 * `tokenProvider` so the test stays hermetic.
 */
import crypto from 'node:crypto';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildBundle } from './build';
import { TokenProvider } from './TokenProvider';

const BASE_URL = 'https://config.smooai.test';
const ORG_ID = '550e8400-e29b-41d4-a716-446655440000';

const server = setupServer(
    http.get(`${BASE_URL}/organizations/:orgId/config/values`, ({ request }) => {
        const url = new URL(request.url);
        const env = url.searchParams.get('environment') || 'development';
        // Same handful of keys regardless of env — we're only checking that
        // the bake records the env we passed it, not that the API knows.
        return HttpResponse.json({
            values: {
                apiUrl: `https://api.${env}.example`,
                sendgridApiKey: `SG.${env}-key`,
            },
        });
    }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

class StubTokenProvider extends TokenProvider {
    constructor() {
        // Constructor needs valid options shape; values unused because
        // getAccessToken is overridden.
        super({ authUrl: 'https://auth.local', clientId: 'x', clientSecret: 'y' });
    }
    async getAccessToken(): Promise<string> {
        return 'stub-token';
    }
}

function decrypt(bundle: Buffer, keyB64: string): { public: Record<string, unknown>; secret: Record<string, unknown>; bakedEnvironment?: string } {
    const key = Buffer.from(keyB64, 'base64');
    const nonce = bundle.subarray(0, 12);
    const authTag = bundle.subarray(bundle.length - 16);
    const ciphertext = bundle.subarray(12, bundle.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return JSON.parse(plaintext);
}

describe('SMOODEV-1136: buildBundle embeds bakedEnvironment', () => {
    it('writes the explicit `environment` option into the blob', async () => {
        const result = await buildBundle({
            baseUrl: BASE_URL,
            orgId: ORG_ID,
            tokenProvider: new StubTokenProvider(),
            environment: 'production',
            classify: () => 'secret',
        });

        const payload = decrypt(result.bundle, result.keyB64);
        expect(payload.bakedEnvironment).toBe('production');
        expect(payload.secret.sendgridApiKey).toBe('SG.production-key');
    });

    it('records "development" when no environment is passed (matches ConfigClient default)', async () => {
        // No `environment` argument and no SMOOAI_CONFIG_ENV in the test
        // env means the ConfigClient's default falls through to 'development'.
        // Test isolates from process.env so a stray export doesn't leak in.
        const saved = process.env.SMOOAI_CONFIG_ENV;
        delete process.env.SMOOAI_CONFIG_ENV;
        try {
            const result = await buildBundle({
                baseUrl: BASE_URL,
                orgId: ORG_ID,
                tokenProvider: new StubTokenProvider(),
                classify: () => 'public',
            });
            const payload = decrypt(result.bundle, result.keyB64);
            expect(payload.bakedEnvironment).toBe('development');
        } finally {
            if (saved !== undefined) process.env.SMOOAI_CONFIG_ENV = saved;
        }
    });
});
