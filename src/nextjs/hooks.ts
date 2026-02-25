'use client';

import { useCallback, useEffect, useState } from 'react';
import { useConfigClient } from '../react/ConfigProvider';

interface UseConfigResult<T = unknown> {
    /** The resolved config value, or undefined while loading (synchronous when pre-seeded). */
    value: T | undefined;
    /** True while the initial fetch is in progress. False immediately if value was pre-seeded. */
    isLoading: boolean;
    /** The error if the fetch failed. */
    error: Error | null;
    /** Re-fetch the value (bypasses cache). */
    refetch: () => void;
}

function useConfigValue(key: string, environment?: string): UseConfigResult {
    const client = useConfigClient();

    // Attempt synchronous read from pre-seeded cache (zero loading flash)
    const [value, setValue] = useState<unknown>(() => client.getCachedValue(key, environment));
    const [isLoading, setIsLoading] = useState(value === undefined);
    const [error, setError] = useState<Error | null>(null);
    const [fetchCount, setFetchCount] = useState(0);

    const refetch = useCallback(() => {
        client.invalidateCache();
        setFetchCount((c) => c + 1);
    }, [client]);

    useEffect(() => {
        // If we already have a cached value and this is the initial mount, skip fetch
        if (value !== undefined && fetchCount === 0) {
            setIsLoading(false);
            return;
        }

        let cancelled = false;
        setIsLoading(true);
        setError(null);

        client
            .getValue(key, environment)
            .then((result) => {
                if (!cancelled) {
                    setValue(result);
                    setIsLoading(false);
                }
            })
            .catch((err: unknown) => {
                if (!cancelled) {
                    setError(err instanceof Error ? err : new Error(String(err)));
                    setIsLoading(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [client, key, environment, fetchCount]);

    return { value, isLoading, error, refetch };
}

/**
 * SSR-aware hook for fetching a public config value.
 * Returns the value synchronously when pre-seeded via `SmooConfigProvider`.
 */
export function usePublicConfig<T = unknown>(key: string, environment?: string): UseConfigResult<T> {
    return useConfigValue(key, environment) as UseConfigResult<T>;
}

/**
 * SSR-aware hook for fetching a feature flag value.
 * Returns the value synchronously when pre-seeded via `SmooConfigProvider`.
 */
export function useFeatureFlag<T = unknown>(key: string, environment?: string): UseConfigResult<T> {
    return useConfigValue(key, environment) as UseConfigResult<T>;
}
