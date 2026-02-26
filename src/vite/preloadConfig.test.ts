import { describe, it, expect, vi, beforeEach } from 'vitest';
import { preloadConfig, getPreloadedConfig, resetPreload } from './preloadConfig';

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

describe('preloadConfig', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetPreload();
    });

    it('fetches all config values', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () =>
                Promise.resolve({
                    values: {
                        API_URL: 'https://api.example.com',
                        ENABLE_NEW_UI: true,
                    },
                }),
        });

        const result = await preloadConfig(BASE_OPTIONS);

        expect(result).toEqual({
            API_URL: 'https://api.example.com',
            ENABLE_NEW_UI: true,
        });
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('returns the same promise on subsequent calls (singleton)', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ values: { API_URL: 'https://api.example.com' } }),
        });

        const promise1 = preloadConfig(BASE_OPTIONS);
        const promise2 = preloadConfig(BASE_OPTIONS);

        expect(promise1).toBe(promise2);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        await promise1;
    });

    it('getPreloadedConfig returns null before completion', () => {
        expect(getPreloadedConfig()).toBeNull();
    });

    it('getPreloadedConfig returns values after completion', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ values: { API_URL: 'https://api.example.com' } }),
        });

        await preloadConfig(BASE_OPTIONS);

        expect(getPreloadedConfig()).toEqual({ API_URL: 'https://api.example.com' });
    });

    it('resetPreload allows a fresh fetch', async () => {
        mockFetch
            .mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ values: { API_URL: 'v1' } }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ values: { API_URL: 'v2' } }),
            });

        await preloadConfig(BASE_OPTIONS);
        expect(getPreloadedConfig()).toEqual({ API_URL: 'v1' });

        resetPreload();
        expect(getPreloadedConfig()).toBeNull();

        await preloadConfig(BASE_OPTIONS);
        expect(getPreloadedConfig()).toEqual({ API_URL: 'v2' });
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });
});
