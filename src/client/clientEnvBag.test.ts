/**
 * Tests for the bundler-baked `__SMOO_CLIENT_ENV__` read path.
 *
 * At runtime, both `smooConfigPlugin` (Vite) and `withSmooConfig` (Next.js)
 * replace `__SMOO_CLIENT_ENV__` with a literal object. In test land, there's
 * no bundler — we simulate the replacement by assigning to `globalThis`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getClientFeatureFlag, getClientPublicConfig } from './index';

type MutableGlobal = typeof globalThis & { __SMOO_CLIENT_ENV__?: Record<string, string> };

afterEach(() => {
    delete (globalThis as MutableGlobal).__SMOO_CLIENT_ENV__;
});

describe('getClientPublicConfig', () => {
    it('reads NEXT_PUBLIC_CONFIG_* keys from the env bag', () => {
        (globalThis as MutableGlobal).__SMOO_CLIENT_ENV__ = {
            NEXT_PUBLIC_CONFIG_API_URL: 'https://api.smoo.ai',
        };
        expect(getClientPublicConfig('apiUrl')).toBe('https://api.smoo.ai');
    });

    it('reads VITE_CONFIG_* keys from the env bag', () => {
        (globalThis as MutableGlobal).__SMOO_CLIENT_ENV__ = {
            VITE_CONFIG_WEB_URL: 'https://smoo.ai',
        };
        expect(getClientPublicConfig('webUrl')).toBe('https://smoo.ai');
    });

    it('prefers NEXT_PUBLIC_CONFIG_* over VITE_CONFIG_* when both are present', () => {
        (globalThis as MutableGlobal).__SMOO_CLIENT_ENV__ = {
            NEXT_PUBLIC_CONFIG_API_URL: 'https://nextjs.value',
            VITE_CONFIG_API_URL: 'https://vite.value',
        };
        expect(getClientPublicConfig('apiUrl')).toBe('https://nextjs.value');
    });

    it('returns undefined when the key is not baked', () => {
        (globalThis as MutableGlobal).__SMOO_CLIENT_ENV__ = {};
        expect(getClientPublicConfig('nope')).toBeUndefined();
    });

    it('returns undefined when neither plugin has run', () => {
        expect(getClientPublicConfig('apiUrl')).toBeUndefined();
    });

    it('camelCases keys to UPPER_SNAKE_CASE before lookup', () => {
        (globalThis as MutableGlobal).__SMOO_CLIENT_ENV__ = {
            NEXT_PUBLIC_CONFIG_API_BASE_URL: 'https://multi-word.key',
        };
        expect(getClientPublicConfig('apiBaseUrl')).toBe('https://multi-word.key');
    });
});

describe('getClientFeatureFlag', () => {
    it('parses "true" / "1" as true', () => {
        (globalThis as MutableGlobal).__SMOO_CLIENT_ENV__ = {
            NEXT_PUBLIC_FEATURE_FLAG_OBSERVABILITY: 'true',
            VITE_FEATURE_FLAG_INTEGRATION_STRIPE: '1',
        };
        expect(getClientFeatureFlag('observability')).toBe(true);
        expect(getClientFeatureFlag('integrationStripe')).toBe(true);
    });

    it('returns false for unrecognised values', () => {
        (globalThis as MutableGlobal).__SMOO_CLIENT_ENV__ = {
            NEXT_PUBLIC_FEATURE_FLAG_X: 'false',
            NEXT_PUBLIC_FEATURE_FLAG_Y: '0',
            NEXT_PUBLIC_FEATURE_FLAG_Z: 'yes',
        };
        expect(getClientFeatureFlag('x')).toBe(false);
        expect(getClientFeatureFlag('y')).toBe(false);
        expect(getClientFeatureFlag('z')).toBe(false);
    });

    it('returns false when the flag is not baked', () => {
        (globalThis as MutableGlobal).__SMOO_CLIENT_ENV__ = {};
        expect(getClientFeatureFlag('aboutPage')).toBe(false);
    });

    it('returns false when neither plugin has run', () => {
        expect(getClientFeatureFlag('aboutPage')).toBe(false);
    });
});
