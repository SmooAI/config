'use client';

import { useCallback, useEffect, useState } from 'react';
import { useConfigClient } from './ConfigProvider';

interface UseConfigResult<T = unknown> {
    /** The resolved config value, or undefined while loading. */
    value: T | undefined;
    /** True while the initial fetch is in progress. */
    isLoading: boolean;
    /** The error if the fetch failed. */
    error: Error | null;
    /** Re-fetch the value (bypasses cache). */
    refetch: () => void;
}

function useConfigValue(key: string, environment?: string): UseConfigResult {
    const client = useConfigClient();
    const [value, setValue] = useState<unknown>(undefined);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);
    const [fetchCount, setFetchCount] = useState(0);

    const refetch = useCallback(() => {
        client.invalidateCache();
        setFetchCount((c) => c + 1);
    }, [client]);

    useEffect(() => {
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
 * Fetch a public config value by key.
 *
 * ```tsx
 * const { value, isLoading, error } = usePublicConfig('API_URL');
 * ```
 */
export function usePublicConfig<T = unknown>(key: string, environment?: string): UseConfigResult<T> {
    return useConfigValue(key, environment) as UseConfigResult<T>;
}

/**
 * Fetch a secret config value by key.
 *
 * ```tsx
 * const { value, isLoading } = useSecretConfig('DATABASE_URL');
 * ```
 */
export function useSecretConfig<T = unknown>(key: string, environment?: string): UseConfigResult<T> {
    return useConfigValue(key, environment) as UseConfigResult<T>;
}

/**
 * Fetch a feature flag value by key.
 *
 * ```tsx
 * const { value: enableNewUI } = useFeatureFlag<boolean>('ENABLE_NEW_UI');
 * ```
 */
export function useFeatureFlag<T = unknown>(key: string, environment?: string): UseConfigResult<T> {
    return useConfigValue(key, environment) as UseConfigResult<T>;
}
