/**
 * Unit tests for the segment-evaluation hooks.
 *
 * Deliberately a plain `.test.tsx`, not `.integration.test.ts`: the integration
 * config is a separate vitest project that no workflow currently runs, so a test
 * placed there would never execute in CI.
 *
 * @vitest-environment jsdom
 */
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigClient, EvaluateFeatureFlagResponse, EvaluateLimitResponse } from '../platform/client';
import { ConfigContext } from './ConfigProvider';
import { useFeatureFlagEvaluation, useLimitEvaluation } from './hooks';

function wrapperFor(client: Partial<ConfigClient>) {
    return ({ children }: { children: ReactNode }) => createElement(ConfigContext.Provider, { value: client as ConfigClient }, children);
}

const FLAG_RESPONSE: EvaluateFeatureFlagResponse = {
    value: true,
    matchedRuleId: 'rule-enterprise',
    rolloutBucket: 42,
    source: 'rule',
};

describe('useFeatureFlagEvaluation', () => {
    it('returns the evaluated value and the evaluator metadata', async () => {
        const evaluateFeatureFlag = vi.fn().mockResolvedValue(FLAG_RESPONSE);
        const { result } = renderHook(() => useFeatureFlagEvaluation<boolean>('enableNewUi', { plan: 'enterprise' }), {
            wrapper: wrapperFor({ evaluateFeatureFlag } as Partial<ConfigClient>),
        });

        expect(result.current.isLoading).toBe(true);
        await waitFor(() => expect(result.current.isLoading).toBe(false));

        expect(result.current.value).toBe(true);
        expect(result.current.matchedRuleId).toBe('rule-enterprise');
        expect(result.current.rolloutBucket).toBe(42);
        expect(result.current.source).toBe('rule');
        expect(result.current.error).toBeNull();
        expect(evaluateFeatureFlag).toHaveBeenCalledWith('enableNewUi', { plan: 'enterprise' }, undefined);
    });

    it('passes the environment through', async () => {
        const evaluateFeatureFlag = vi.fn().mockResolvedValue(FLAG_RESPONSE);
        renderHook(() => useFeatureFlagEvaluation('enableNewUi', undefined, 'staging'), {
            wrapper: wrapperFor({ evaluateFeatureFlag } as Partial<ConfigClient>),
        });

        await waitFor(() => expect(evaluateFeatureFlag).toHaveBeenCalledWith('enableNewUi', {}, 'staging'));
    });

    // The footgun this hook exists to survive: callers write the context inline,
    // so a fresh object arrives every render. Depending on the object identity
    // would re-fire the effect forever.
    it('does not re-evaluate when an equal context arrives as a new object', async () => {
        const evaluateFeatureFlag = vi.fn().mockResolvedValue(FLAG_RESPONSE);
        const { rerender } = renderHook(({ userId }: { userId: string }) => useFeatureFlagEvaluation('enableNewUi', { userId }), {
            wrapper: wrapperFor({ evaluateFeatureFlag } as Partial<ConfigClient>),
            initialProps: { userId: 'u-1' },
        });

        await waitFor(() => expect(evaluateFeatureFlag).toHaveBeenCalledTimes(1));

        rerender({ userId: 'u-1' });
        rerender({ userId: 'u-1' });
        await waitFor(() => expect(evaluateFeatureFlag).toHaveBeenCalledTimes(1));
    });

    it('re-evaluates when a context VALUE changes', async () => {
        const evaluateFeatureFlag = vi.fn().mockResolvedValue(FLAG_RESPONSE);
        const { rerender } = renderHook(({ userId }: { userId: string }) => useFeatureFlagEvaluation('enableNewUi', { userId }), {
            wrapper: wrapperFor({ evaluateFeatureFlag } as Partial<ConfigClient>),
            initialProps: { userId: 'u-1' },
        });

        await waitFor(() => expect(evaluateFeatureFlag).toHaveBeenCalledTimes(1));

        rerender({ userId: 'u-2' });
        await waitFor(() => expect(evaluateFeatureFlag).toHaveBeenCalledTimes(2));
        expect(evaluateFeatureFlag).toHaveBeenLastCalledWith('enableNewUi', { userId: 'u-2' }, undefined);
    });

    it('surfaces an evaluation failure as an Error and stops loading', async () => {
        const evaluateFeatureFlag = vi.fn().mockRejectedValue(new Error('HTTP 404'));
        const { result } = renderHook(() => useFeatureFlagEvaluation('missingFlag'), {
            wrapper: wrapperFor({ evaluateFeatureFlag } as Partial<ConfigClient>),
        });

        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.error).toBeInstanceOf(Error);
        expect(result.current.error?.message).toBe('HTTP 404');
        expect(result.current.value).toBeUndefined();
    });

    it('refetch re-runs the evaluation', async () => {
        const evaluateFeatureFlag = vi.fn().mockResolvedValue(FLAG_RESPONSE);
        const { result } = renderHook(() => useFeatureFlagEvaluation('enableNewUi'), {
            wrapper: wrapperFor({ evaluateFeatureFlag } as Partial<ConfigClient>),
        });

        await waitFor(() => expect(evaluateFeatureFlag).toHaveBeenCalledTimes(1));
        result.current.refetch();
        await waitFor(() => expect(evaluateFeatureFlag).toHaveBeenCalledTimes(2));
    });
});

describe('useLimitEvaluation', () => {
    it('evaluates through the limit endpoint, not the flag one', async () => {
        const response: EvaluateLimitResponse = { value: 25, source: 'rollout', rolloutBucket: 7 };
        const evaluateLimit = vi.fn().mockResolvedValue(response);
        const evaluateFeatureFlag = vi.fn();

        const { result } = renderHook(() => useLimitEvaluation('maxSeats', { tenantId: 'org-1' }), {
            wrapper: wrapperFor({ evaluateLimit, evaluateFeatureFlag } as Partial<ConfigClient>),
        });

        await waitFor(() => expect(result.current.isLoading).toBe(false));

        expect(result.current.value).toBe(25);
        expect(result.current.source).toBe('rollout');
        expect(result.current.rolloutBucket).toBe(7);
        expect(evaluateLimit).toHaveBeenCalledWith('maxSeats', { tenantId: 'org-1' }, undefined);
        expect(evaluateFeatureFlag).not.toHaveBeenCalled();
    });
});
