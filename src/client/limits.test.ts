import { defineConfig, defineLimit } from '@/config/config';
import type { ConfigClient, EvaluateLimitResponse } from '@/platform/client';
import { describe, it, expect, vi } from 'vitest';
import { buildClientConfig } from './index';

const schema = defineConfig({
    limitsSchema: {
        agentMaxIterations: defineLimit({ default: 12, min: 1, max: 50 }),
    },
});

/** Minimal ConfigClient stub — only `evaluateLimit` is exercised here. */
function stubClient(evaluateLimit: (key: string, ctx?: Record<string, unknown>, env?: string) => Promise<EvaluateLimitResponse>): ConfigClient {
    return { evaluateLimit } as unknown as ConfigClient;
}

describe('buildClientConfig limit tier', () => {
    it('getLimit returns the clamped schema default when nothing is baked', () => {
        const config = buildClientConfig(schema, { httpClient: stubClient(async () => ({ value: 0, source: 'default' })) });
        expect(config.limit.getLimit('agentMaxIterations')).toBe(12);
    });

    it('evaluateLimit clamps the resolved value and reports the raw value + source', async () => {
        const evaluateLimit = vi.fn(async () => ({ value: 999, source: 'rule', matchedRuleId: 'r-1' }) as EvaluateLimitResponse);
        const config = buildClientConfig(schema, { httpClient: stubClient(evaluateLimit) });

        const result = await config.limit.evaluateLimit('agentMaxIterations', { orgId: 'o-1', agentId: 'a-1' });

        expect(result).toEqual({
            value: 50, // clamped from 999 into [1, 50]
            rawValue: 999,
            matchedRuleId: 'r-1',
            rolloutBucket: undefined,
            source: 'rule',
            clamped: true,
        });
        expect(evaluateLimit).toHaveBeenCalledWith('agentMaxIterations', { orgId: 'o-1', agentId: 'a-1' }, undefined);
    });

    it('evaluateLimit marks clamped=false when the value is already in range', async () => {
        const config = buildClientConfig(schema, { httpClient: stubClient(async () => ({ value: 20, source: 'raw' })) });
        const result = await config.limit.evaluateLimit('agentMaxIterations');
        expect(result.value).toBe(20);
        expect(result.clamped).toBe(false);
    });
});
