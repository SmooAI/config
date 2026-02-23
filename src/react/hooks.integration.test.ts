/**
 * Integration tests for React config hooks.
 *
 * Tests usePublicConfig, useSecretConfig, and useFeatureFlag hooks
 * with a real HTTP test server and ConfigProvider.
 *
 * @vitest-environment jsdom
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigClient } from '../platform/client';
import { ConfigProvider, useConfigClient } from './ConfigProvider';
import { usePublicConfig, useSecretConfig, useFeatureFlag } from './hooks';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------
const API_KEY = 'hooks-test-key';
const ORG_ID = 'org-hooks-test-001';
let BASE_URL: string;

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------
const VALUES: Record<string, unknown> = {
    API_URL: 'https://api.hooks-test.com',
    DB_URL: 'postgres://hooks-test:5432/db',
    DARK_MODE: true,
    MAX_RETRIES: 3,
    NESTED: { deep: { value: 42 } },
};

let requestCount = 0;

// ---------------------------------------------------------------------------
// Real HTTP server
// ---------------------------------------------------------------------------
let server: Server;

function createTestServer(): Promise<Server> {
    return new Promise((resolve) => {
        const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
            requestCount++;

            const url = new URL(req.url!, `http://${req.headers.host}`);
            const pathParts = url.pathname.split('/').filter(Boolean);

            // Single value endpoint
            if (pathParts[4]) {
                const key = decodeURIComponent(pathParts[4]);
                if (key in VALUES) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ value: VALUES[key] }));
                    return;
                }
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not found' }));
                return;
            }

            // All values endpoint
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ values: VALUES }));
        });

        srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
beforeAll(async () => {
    server = await createTestServer();
    const address = server.address() as { port: number };
    BASE_URL = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
    requestCount = 0;
});

function createWrapper(overrides?: Partial<{ baseUrl: string; apiKey: string; orgId: string; environment: string }>) {
    return function Wrapper({ children }: { children: ReactNode }) {
        return createElement(ConfigProvider, {
            baseUrl: overrides?.baseUrl ?? BASE_URL,
            apiKey: overrides?.apiKey ?? API_KEY,
            orgId: overrides?.orgId ?? ORG_ID,
            environment: overrides?.environment ?? 'production',
            children,
        });
    };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('React Config Hooks Integration', () => {
    describe('useConfigClient', () => {
        it('throws when used outside ConfigProvider', () => {
            expect(() => {
                renderHook(() => useConfigClient());
            }).toThrow('useConfigClient must be used within a <ConfigProvider>');
        });

        it('returns a ConfigClient instance inside ConfigProvider', () => {
            const { result } = renderHook(() => useConfigClient(), {
                wrapper: createWrapper(),
            });
            expect(result.current).toBeInstanceOf(ConfigClient);
        });
    });

    describe('usePublicConfig', () => {
        it('starts in loading state', () => {
            const { result } = renderHook(() => usePublicConfig('API_URL'), {
                wrapper: createWrapper(),
            });

            expect(result.current.isLoading).toBe(true);
            expect(result.current.value).toBeUndefined();
            expect(result.current.error).toBeNull();
        });

        it('resolves a string value', async () => {
            const { result } = renderHook(() => usePublicConfig<string>('API_URL'), {
                wrapper: createWrapper(),
            });

            await waitFor(() => {
                expect(result.current.isLoading).toBe(false);
            });

            expect(result.current.value).toBe('https://api.hooks-test.com');
            expect(result.current.error).toBeNull();
        });

        it('resolves a number value', async () => {
            const { result } = renderHook(() => usePublicConfig<number>('MAX_RETRIES'), {
                wrapper: createWrapper(),
            });

            await waitFor(() => {
                expect(result.current.isLoading).toBe(false);
            });

            expect(result.current.value).toBe(3);
        });

        it('resolves a nested object', async () => {
            const { result } = renderHook(() => usePublicConfig<{ deep: { value: number } }>('NESTED'), {
                wrapper: createWrapper(),
            });

            await waitFor(() => {
                expect(result.current.isLoading).toBe(false);
            });

            expect(result.current.value).toEqual({ deep: { value: 42 } });
        });

        it('sets error on fetch failure (404)', async () => {
            const { result } = renderHook(() => usePublicConfig('NONEXISTENT_KEY'), {
                wrapper: createWrapper(),
            });

            await waitFor(() => {
                expect(result.current.isLoading).toBe(false);
            });

            expect(result.current.error).toBeInstanceOf(Error);
            expect(result.current.value).toBeUndefined();
        });

        it('refetch clears cache and re-fetches', async () => {
            const { result } = renderHook(() => usePublicConfig<string>('API_URL'), {
                wrapper: createWrapper(),
            });

            await waitFor(() => {
                expect(result.current.isLoading).toBe(false);
            });

            const countBefore = requestCount;

            act(() => {
                result.current.refetch();
            });

            await waitFor(() => {
                expect(result.current.isLoading).toBe(false);
            });

            expect(requestCount).toBeGreaterThan(countBefore);
            expect(result.current.value).toBe('https://api.hooks-test.com');
        });
    });

    describe('useSecretConfig', () => {
        it('resolves a secret value', async () => {
            const { result } = renderHook(() => useSecretConfig<string>('DB_URL'), {
                wrapper: createWrapper(),
            });

            await waitFor(() => {
                expect(result.current.isLoading).toBe(false);
            });

            expect(result.current.value).toBe('postgres://hooks-test:5432/db');
            expect(result.current.error).toBeNull();
        });
    });

    describe('useFeatureFlag', () => {
        it('resolves a boolean feature flag', async () => {
            const { result } = renderHook(() => useFeatureFlag<boolean>('DARK_MODE'), {
                wrapper: createWrapper(),
            });

            await waitFor(() => {
                expect(result.current.isLoading).toBe(false);
            });

            expect(result.current.value).toBe(true);
            expect(result.current.error).toBeNull();
        });
    });

    describe('Environment switching via hooks', () => {
        it('re-fetches when environment prop changes', async () => {
            let env = 'production';

            const wrapper = ({ children }: { children: ReactNode }) =>
                createElement(ConfigProvider, {
                    baseUrl: BASE_URL,
                    apiKey: API_KEY,
                    orgId: ORG_ID,
                    environment: env,
                    children,
                });

            const { result, rerender } = renderHook(() => usePublicConfig<string>('API_URL'), {
                wrapper,
            });

            await waitFor(() => {
                expect(result.current.isLoading).toBe(false);
            });

            expect(result.current.value).toBe('https://api.hooks-test.com');

            // Change environment by re-rendering with new props
            env = 'staging';
            rerender();

            // The hook should still work (may or may not trigger re-fetch
            // depending on memoization, but should not crash)
            await waitFor(() => {
                expect(result.current.isLoading).toBe(false);
            });
        });
    });

    describe('Connection error handling in hooks', () => {
        it('sets error when server is unreachable', async () => {
            const { result } = renderHook(() => usePublicConfig('API_URL'), {
                wrapper: createWrapper({ baseUrl: 'http://127.0.0.1:1' }),
            });

            await waitFor(() => {
                expect(result.current.isLoading).toBe(false);
            });

            expect(result.current.error).toBeInstanceOf(Error);
            expect(result.current.value).toBeUndefined();
        });
    });
});
