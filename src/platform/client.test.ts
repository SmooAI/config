import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigClient, FeatureFlagContextError, FeatureFlagEvaluationError, FeatureFlagNotFoundError } from './client';

// Mock @smooai/fetch module
const { mockFetch } = vi.hoisted(() => ({
    mockFetch: vi.fn(),
}));
vi.mock('@smooai/fetch', () => ({
    default: mockFetch,
}));

const BASE_OPTIONS = {
    baseUrl: 'https://api.smooai.dev',
    apiKey: 'test-key',
    orgId: 'org-123',
    environment: 'production',
};

describe('ConfigClient', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('seedCache', () => {
        it('pre-populates a single cache entry', async () => {
            const client = new ConfigClient(BASE_OPTIONS);
            client.seedCache('API_URL', 'https://api.example.com');

            // Should return cached value without fetching
            const value = await client.getValue('API_URL');
            expect(value).toBe('https://api.example.com');
            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('uses specified environment for cache key', async () => {
            const client = new ConfigClient(BASE_OPTIONS);
            client.seedCache('API_URL', 'https://staging.example.com', 'staging');

            // Default env should miss
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ value: 'https://prod.example.com' }),
            });
            const prodValue = await client.getValue('API_URL');
            expect(prodValue).toBe('https://prod.example.com');
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });
    });

    describe('seedCacheFromMap', () => {
        it('pre-populates multiple cache entries', async () => {
            const client = new ConfigClient(BASE_OPTIONS);
            client.seedCacheFromMap({
                API_URL: 'https://api.example.com',
                ENABLE_NEW_UI: true,
                MAX_RETRIES: 3,
            });

            // All should be cached
            expect(await client.getValue('API_URL')).toBe('https://api.example.com');
            expect(await client.getValue('ENABLE_NEW_UI')).toBe(true);
            expect(await client.getValue('MAX_RETRIES')).toBe(3);
            expect(mockFetch).not.toHaveBeenCalled();
        });
    });

    describe('getCachedValue', () => {
        it('returns undefined for non-cached keys', () => {
            const client = new ConfigClient(BASE_OPTIONS);
            expect(client.getCachedValue('MISSING_KEY')).toBeUndefined();
        });

        it('returns seeded value synchronously', () => {
            const client = new ConfigClient(BASE_OPTIONS);
            client.seedCache('API_URL', 'https://api.example.com');
            expect(client.getCachedValue('API_URL')).toBe('https://api.example.com');
        });

        it('respects environment parameter', () => {
            const client = new ConfigClient(BASE_OPTIONS);
            client.seedCache('API_URL', 'https://staging.example.com', 'staging');
            expect(client.getCachedValue('API_URL', 'staging')).toBe('https://staging.example.com');
            expect(client.getCachedValue('API_URL', 'production')).toBeUndefined();
        });
    });

    describe('fetchOptions', () => {
        it('passes fetchOptions to getAllValues', async () => {
            const client = new ConfigClient(BASE_OPTIONS);
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ values: { API_URL: 'https://api.example.com' } }),
            });

            const fetchOptions = { next: { revalidate: 60 } } as RequestInit;
            await client.getAllValues('production', fetchOptions);

            expect(mockFetch).toHaveBeenCalledWith(
                expect.stringContaining('/config/values'),
                expect.objectContaining({
                    next: { revalidate: 60 },
                    headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
                }),
            );
        });

        it('merges fetchOptions headers with auth header', async () => {
            const client = new ConfigClient(BASE_OPTIONS);
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ values: {} }),
            });

            await client.getAllValues('production', {
                headers: { 'X-Custom': 'value' },
            });

            expect(mockFetch).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer test-key',
                        'X-Custom': 'value',
                    }),
                }),
            );
        });
    });

    describe('evaluateFeatureFlag', () => {
        it('POSTs to the evaluator with environment + context and returns the response', async () => {
            const client = new ConfigClient(BASE_OPTIONS);
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ value: true, source: 'rule', matchedRuleId: 'rule-123' }),
            });

            const result = await client.evaluateFeatureFlag('aboutPage', { userId: 'u-1', plan: 'pro' });

            expect(result).toEqual({ value: true, source: 'rule', matchedRuleId: 'rule-123' });
            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.smooai.dev/organizations/org-123/config/feature-flags/aboutPage/evaluate',
                expect.objectContaining({
                    method: 'POST',
                    body: JSON.stringify({ environment: 'production', context: { userId: 'u-1', plan: 'pro' } }),
                    headers: expect.objectContaining({
                        Authorization: 'Bearer test-key',
                        'Content-Type': 'application/json',
                    }),
                }),
            );
        });

        it('defaults context to {} when omitted', async () => {
            const client = new ConfigClient(BASE_OPTIONS);
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ value: false, source: 'default' }),
            });

            await client.evaluateFeatureFlag('aboutPage');

            expect(mockFetch).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    body: JSON.stringify({ environment: 'production', context: {} }),
                }),
            );
        });

        it('honors an explicit environment override', async () => {
            const client = new ConfigClient(BASE_OPTIONS);
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ value: true, source: 'raw' }),
            });

            await client.evaluateFeatureFlag('aboutPage', {}, 'staging');

            expect(mockFetch).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    body: JSON.stringify({ environment: 'staging', context: {} }),
                }),
            );
        });

        it('URL-encodes flag keys with special characters', async () => {
            const client = new ConfigClient(BASE_OPTIONS);
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ value: null, source: 'default' }),
            });

            await client.evaluateFeatureFlag('with spaces/and+slashes');

            expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('with%20spaces%2Fand%2Bslashes'), expect.anything());
        });

        it('throws FeatureFlagNotFoundError on 404', async () => {
            const client = new ConfigClient(BASE_OPTIONS);
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404,
                text: () => Promise.resolve('flag not defined'),
            });

            const err = await client.evaluateFeatureFlag('unknown').catch((e) => e);
            expect(err).toBeInstanceOf(FeatureFlagNotFoundError);
            expect(err).toBeInstanceOf(FeatureFlagEvaluationError);
            expect(err.key).toBe('unknown');
            expect(err.statusCode).toBe(404);
        });

        it('throws FeatureFlagContextError on 400', async () => {
            const client = new ConfigClient(BASE_OPTIONS);
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 400,
                text: () => Promise.resolve('context missing required key'),
            });

            const err = await client.evaluateFeatureFlag('aboutPage').catch((e) => e);
            expect(err).toBeInstanceOf(FeatureFlagContextError);
            expect(err.statusCode).toBe(400);
            expect(err.serverMessage).toBe('context missing required key');
        });

        it('throws FeatureFlagEvaluationError on 5xx', async () => {
            const client = new ConfigClient(BASE_OPTIONS);
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 503,
                text: () => Promise.resolve('evaluator overloaded'),
            });

            const err = await client.evaluateFeatureFlag('aboutPage').catch((e) => e);
            expect(err).toBeInstanceOf(FeatureFlagEvaluationError);
            expect(err).not.toBeInstanceOf(FeatureFlagNotFoundError);
            expect(err).not.toBeInstanceOf(FeatureFlagContextError);
            expect(err.statusCode).toBe(503);
        });
    });
});
