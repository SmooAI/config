'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EvaluateFeatureFlagResponse, EvaluateLimitResponse } from '../platform/client';
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

/**
 * Result of a live, segment-aware evaluation. Richer than {@link UseConfigResult}
 * because the evaluator reports *why* it returned what it did.
 */
export interface UseEvaluationResult<T = unknown> {
    /** The resolved value, or undefined while loading or on error. */
    value: T | undefined;
    /** Id of the segment rule that fired, if any. */
    matchedRuleId: string | undefined;
    /** 0–99 bucket the context was assigned to, if a rollout ran. */
    rolloutBucket: number | undefined;
    /** Which branch the evaluator returned from. */
    source: EvaluateFeatureFlagResponse['source'] | undefined;
    /** True while the evaluation request is in flight. */
    isLoading: boolean;
    /** The error if evaluation failed. */
    error: Error | null;
    /** Re-run the evaluation. */
    refetch: () => void;
}

/**
 * Shared engine for the two evaluation hooks. Segment evaluation is always a
 * network call — the server owns the rules — so there is no sync variant and
 * no cache to invalidate.
 */
function useEvaluation(
    evaluate: (key: string, context: Record<string, unknown>, environment?: string) => Promise<EvaluateFeatureFlagResponse | EvaluateLimitResponse>,
    key: string,
    context?: Record<string, unknown>,
    environment?: string,
): UseEvaluationResult {
    const [result, setResult] = useState<EvaluateFeatureFlagResponse | EvaluateLimitResponse | undefined>(undefined);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);
    const [fetchCount, setFetchCount] = useState(0);

    // Context is an object literal at almost every call site, so a fresh
    // reference arrives on every render. Depending on the object directly would
    // re-fire the effect forever; depending on its serialization re-fires only
    // when the context's VALUES change, which is what callers mean.
    const contextKey = useMemo(() => JSON.stringify(context ?? {}), [context]);

    const refetch = useCallback(() => setFetchCount((count) => count + 1), []);

    useEffect(() => {
        let cancelled = false;
        setIsLoading(true);
        setError(null);

        evaluate(key, JSON.parse(contextKey) as Record<string, unknown>, environment)
            .then((response) => {
                if (cancelled) return;
                setResult(response);
                setIsLoading(false);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setError(err instanceof Error ? err : new Error(String(err)));
                setIsLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [evaluate, key, contextKey, environment, fetchCount]);

    return {
        value: result?.value,
        matchedRuleId: result?.matchedRuleId,
        rolloutBucket: result?.rolloutBucket,
        source: result?.source,
        isLoading,
        error,
        refetch,
    };
}

/**
 * Evaluate a feature flag against a segment context, server-side.
 *
 * Unlike {@link useFeatureFlag} — which reads the flag's stored value — this
 * runs the org's segment rules and percentage rollout for the context you pass,
 * and reports which branch produced the answer.
 *
 * ```tsx
 * const { value, source, matchedRuleId } = useFeatureFlagEvaluation<boolean>('enableNewUI', {
 *     userId: user.id,
 *     plan: org.plan,
 * });
 * ```
 */
export function useFeatureFlagEvaluation<T = unknown>(key: string, context?: Record<string, unknown>, environment?: string): UseEvaluationResult<T> {
    const client = useConfigClient();
    const evaluate = useCallback(
        (flagKey: string, flagContext: Record<string, unknown>, env?: string) => client.evaluateFeatureFlag(flagKey, flagContext, env),
        [client],
    );

    return useEvaluation(evaluate, key, context, environment) as UseEvaluationResult<T>;
}

/**
 * Evaluate a numeric limit against a segment context, server-side.
 *
 * The sibling of {@link useFeatureFlagEvaluation} — same evaluator, typed as a
 * number. Note the value is the RAW server result; clamping into the schema's
 * `[min, max]` is the `limit` tier's job in `buildClientConfig`.
 *
 * ```tsx
 * const { value: seatLimit } = useLimitEvaluation('maxSeats', { tenantId: org.id });
 * ```
 */
export function useLimitEvaluation(key: string, context?: Record<string, unknown>, environment?: string): UseEvaluationResult<number> {
    const client = useConfigClient();
    const evaluate = useCallback(
        (limitKey: string, limitContext: Record<string, unknown>, env?: string) => client.evaluateLimit(limitKey, limitContext, env),
        [client],
    );

    return useEvaluation(evaluate, key, context, environment) as UseEvaluationResult<number>;
}
