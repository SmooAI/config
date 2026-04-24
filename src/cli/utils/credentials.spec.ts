import { describe, it, expect } from 'vitest';
import { deriveAuthUrlFromBaseUrl, isOAuthCredentials, maskSecret } from './credentials';

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
