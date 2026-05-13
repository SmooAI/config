import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @smooai/fetch module
const { mockFetch } = vi.hoisted(() => ({
    mockFetch: vi.fn(),
}));
vi.mock('@smooai/fetch', () => ({
    default: mockFetch,
}));

import { TokenProvider } from '../platform/TokenProvider';
import { getConfig } from './getConfig';

// SMOODEV-974: stub TokenProvider so these tests focus on getConfig behavior,
// not the OAuth handshake (covered by TokenProvider.test.ts).
class StubTokenProvider extends TokenProvider {
    constructor() {
        super({ authUrl: 'https://stub.invalid', clientId: 'stub', clientSecret: 'stub' });
    }
    async getAccessToken(): Promise<string> {
        return 'stub-jwt';
    }
}

const BASE_OPTIONS = {
    baseUrl: 'https://api.smooai.dev',
    orgId: 'org-123',
    environment: 'production',
    tokenProvider: new StubTokenProvider(),
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
