import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { getConfig } from './getConfig';

const BASE_OPTIONS = {
    baseUrl: 'https://api.smooai.dev',
    apiKey: 'test-key',
    orgId: 'org-123',
    environment: 'production',
};

describe('getConfig', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('fetches all values for the environment', async () => {
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

        const result = await getConfig(BASE_OPTIONS);

        expect(result).toEqual({
            API_URL: 'https://api.example.com',
            ENABLE_NEW_UI: true,
        });
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('fetches specific keys when provided', async () => {
        mockFetch
            .mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ value: 'https://api.example.com' }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ value: true }),
            });

        const result = await getConfig({
            ...BASE_OPTIONS,
            keys: ['API_URL', 'ENABLE_NEW_UI'],
        });

        expect(result).toEqual({
            API_URL: 'https://api.example.com',
            ENABLE_NEW_UI: true,
        });
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('passes fetchOptions through to the underlying fetch', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ values: {} }),
        });

        await getConfig({
            ...BASE_OPTIONS,
            fetchOptions: { next: { revalidate: 60 } } as RequestInit,
        });

        expect(mockFetch).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                next: { revalidate: 60 },
            }),
        );
    });
});
