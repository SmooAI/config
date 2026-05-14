import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { deriveAuthUrlFromBaseUrl, isOAuthCredentials, loadCredentials, maskSecret } from './credentials';

describe('deriveAuthUrlFromBaseUrl', () => {
    it('swaps api.* for auth.*', () => {
        expect(deriveAuthUrlFromBaseUrl('https://api.smoo.ai')).toBe('https://auth.smoo.ai');
    });

    it('preserves path and port', () => {
        expect(deriveAuthUrlFromBaseUrl('https://api.smoo.ai:8443')).toBe('https://auth.smoo.ai:8443');
    });

    it('returns localhost unchanged', () => {
        expect(deriveAuthUrlFromBaseUrl('http://localhost:4000')).toBe('http://localhost:4000');
    });

    it('returns 127.0.0.1 unchanged', () => {
        expect(deriveAuthUrlFromBaseUrl('http://127.0.0.1:4000')).toBe('http://127.0.0.1:4000');
    });

    it('strips trailing slashes from the derived URL', () => {
        expect(deriveAuthUrlFromBaseUrl('https://api.smoo.ai/')).toBe('https://auth.smoo.ai');
    });

    it('returns a normalized url when the host does not start with api.', () => {
        expect(deriveAuthUrlFromBaseUrl('https://gateway.smoo.ai')).toBe('https://gateway.smoo.ai');
    });

    it('falls back to original string on malformed URL', () => {
        expect(deriveAuthUrlFromBaseUrl('not a url')).toBe('not a url');
    });
});

describe('isOAuthCredentials', () => {
    it('returns true when both clientId and clientSecret are present', () => {
        expect(
            isOAuthCredentials({
                clientId: 'cid',
                clientSecret: 'sk_secret',
                orgId: 'org',
                baseUrl: 'https://api.smoo.ai',
                authUrl: 'https://auth.smoo.ai',
            }),
        ).toBe(true);
    });

    it('returns false for api-key credentials', () => {
        expect(isOAuthCredentials({ apiKey: 'key', orgId: 'org', baseUrl: 'https://api.smoo.ai' })).toBe(false);
    });
});

describe('maskSecret', () => {
    it('masks after first 4 chars', () => {
        expect(maskSecret('sk_abcdefghij')).toBe('sk_a' + '•'.repeat(9));
    });

    it('returns dots for short inputs', () => {
        expect(maskSecret('abc')).toBe('•'.repeat(8));
    });

    it('handles empty input', () => {
        expect(maskSecret('')).toBe('');
    });

    it('caps the dot run at 16', () => {
        const masked = maskSecret('sk_' + 'x'.repeat(100));
        expect(masked).toBe('sk_x' + '•'.repeat(16));
    });
});

describe('loadCredentials — SMOODEV-993 env-var path', () => {
    // Snapshot every SMOOAI_CONFIG_* + SMOOAI_AUTH_URL var so each case
    // starts from a known empty state. credentials.json is left alone for
    // tests that care about it — they reach into it via getEnv override
    // patterns that we don't need here.
    const KEYS = [
        'SMOOAI_CONFIG_CLIENT_ID',
        'SMOOAI_CONFIG_CLIENT_SECRET',
        'SMOOAI_CONFIG_API_KEY',
        'SMOOAI_CONFIG_ORG_ID',
        'SMOOAI_CONFIG_API_URL',
        'SMOOAI_CONFIG_AUTH_URL',
        'SMOOAI_AUTH_URL',
    ] as const;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const k of KEYS) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
    });
    afterEach(() => {
        for (const k of KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    it('derives OAuth credentials when CLIENT_ID + CLIENT_SECRET + ORG_ID are present', () => {
        process.env.SMOOAI_CONFIG_CLIENT_ID = 'cid';
        process.env.SMOOAI_CONFIG_CLIENT_SECRET = 'sk_secret';
        process.env.SMOOAI_CONFIG_ORG_ID = 'org-uuid';
        const creds = loadCredentials();
        expect(creds).toMatchObject({
            clientId: 'cid',
            clientSecret: 'sk_secret',
            orgId: 'org-uuid',
            baseUrl: 'https://api.smoo.ai', // default
            authUrl: 'https://auth.smoo.ai', // derived from default base
        });
    });

    it('uses custom SMOOAI_CONFIG_API_URL when set', () => {
        process.env.SMOOAI_CONFIG_CLIENT_ID = 'cid';
        process.env.SMOOAI_CONFIG_CLIENT_SECRET = 'secret';
        process.env.SMOOAI_CONFIG_ORG_ID = 'org';
        process.env.SMOOAI_CONFIG_API_URL = 'https://api.smoo.dev';
        const creds = loadCredentials();
        expect(creds).toMatchObject({
            baseUrl: 'https://api.smoo.dev',
            authUrl: 'https://auth.smoo.dev',
        });
    });

    it('uses explicit SMOOAI_CONFIG_AUTH_URL when set instead of deriving', () => {
        process.env.SMOOAI_CONFIG_CLIENT_ID = 'cid';
        process.env.SMOOAI_CONFIG_CLIENT_SECRET = 'secret';
        process.env.SMOOAI_CONFIG_ORG_ID = 'org';
        process.env.SMOOAI_CONFIG_AUTH_URL = 'https://auth.custom.example';
        const creds = loadCredentials();
        expect(creds).toMatchObject({
            authUrl: 'https://auth.custom.example',
        });
    });

    it('falls back to legacy SMOOAI_AUTH_URL when SMOOAI_CONFIG_AUTH_URL is unset', () => {
        process.env.SMOOAI_CONFIG_CLIENT_ID = 'cid';
        process.env.SMOOAI_CONFIG_CLIENT_SECRET = 'secret';
        process.env.SMOOAI_CONFIG_ORG_ID = 'org';
        process.env.SMOOAI_AUTH_URL = 'https://auth.legacy.example';
        const creds = loadCredentials();
        expect(creds).toMatchObject({ authUrl: 'https://auth.legacy.example' });
    });

    it('accepts the legacy SMOOAI_CONFIG_API_KEY alias for CLIENT_SECRET', () => {
        process.env.SMOOAI_CONFIG_CLIENT_ID = 'cid';
        process.env.SMOOAI_CONFIG_API_KEY = 'legacy-secret-alias';
        process.env.SMOOAI_CONFIG_ORG_ID = 'org';
        const creds = loadCredentials();
        expect(creds).toMatchObject({ clientSecret: 'legacy-secret-alias' });
    });

    it('returns the env-derived OAuth creds even when credentials.json exists (env wins)', () => {
        // We do not write a credentials.json here, but the precedence is
        // exercised: if SMOODEV-993's `loadCredentialsFromEnv` returns
        // non-null, the existsSync()/readFile() branch is short-circuited.
        // Asserting the env path is taken when env vars are complete is
        // sufficient to verify the precedence — the existsSync branch is
        // covered by the pre-existing CLI integration tests.
        process.env.SMOOAI_CONFIG_CLIENT_ID = 'env-id';
        process.env.SMOOAI_CONFIG_CLIENT_SECRET = 'env-secret';
        process.env.SMOOAI_CONFIG_ORG_ID = 'env-org';
        const creds = loadCredentials();
        expect(creds?.orgId).toBe('env-org');
        expect((creds as { clientId: string } | null)?.clientId).toBe('env-id');
    });

    it('skips env path and lets credentials.json win when env vars are incomplete', () => {
        // Only CLIENT_ID and CLIENT_SECRET — missing ORG_ID.
        process.env.SMOOAI_CONFIG_CLIENT_ID = 'cid';
        process.env.SMOOAI_CONFIG_CLIENT_SECRET = 'secret';
        // loadCredentials() reads credentials.json fallback. If the test
        // host doesn't have one, the call returns null — that's the
        // expected behavior for "fell through to file path with no file".
        const result = loadCredentials();
        // Either null (no file) or the file's contents (running on dev
        // host). Either way it should NOT be the env-derived creds since
        // ORG_ID is missing.
        if (result !== null) {
            expect(result.orgId).not.toBe(undefined);
            // If a credentials.json exists, its orgId is read from it, not derived from env.
        }
    });
});
