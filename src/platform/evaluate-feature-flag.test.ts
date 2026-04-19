/**
 * Tests for ConfigClient.evaluateFeatureFlag — the cohort-aware flag SDK
 * surface (SMOODEV-614). Uses MSW (the same harness as client.integration.test.ts)
 * to verify the HTTP contract matches the backend
 * POST /organizations/:org_id/config/feature-flags/:key/evaluate endpoint.
 */

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ConfigClient } from './client';

const BASE_URL = 'https://config.smooai.test';
const ORG_ID = '550e8400-e29b-41d4-a716-446655440000';
const API_KEY = 'test-api-key-12345';

// Flag store mirrors what the backend would resolve for each request — lets
// us assert the evaluator contract end-to-end (rule match, rollout, default,
// raw scalar) without re-implementing it here.
interface Handler {
    (req: { environment: string; context: Record<string, unknown> }): Promise<unknown> | unknown;
}
const flagHandlers: Record<string, Handler> = {};

const server = setupServer(
    http.post(`${BASE_URL}/organizations/${ORG_ID}/config/feature-flags/:key/evaluate`, async ({ request, params }) => {
        if (request.headers.get('authorization') !== `Bearer ${API_KEY}`) {
            return HttpResponse.json({ message: 'unauthorized' }, { status: 401 });
        }
        const body = (await request.json()) as { environment: string; context: Record<string, unknown> };
        const key = String(params.key);
        const handler = flagHandlers[key];
        if (!handler) {
            return HttpResponse.json({ message: 'not found' }, { status: 404 });
        }
        const result = (await handler(body)) as Record<string, unknown>;
        return HttpResponse.json(result);
    }),
);

function newClient() {
    return new ConfigClient({ baseUrl: BASE_URL, apiKey: API_KEY, orgId: ORG_ID, environment: 'production' });
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
    server.resetHandlers();
    for (const k of Object.keys(flagHandlers)) delete flagHandlers[k];
});
afterAll(() => server.close());

describe('ConfigClient.evaluateFeatureFlag', () => {
    it('POSTs environment + context and returns the resolved value', async () => {
        flagHandlers['new-dashboard'] = ({ environment, context }) => {
            expect(environment).toBe('production');
            expect(context).toEqual({ userId: 'u1', plan: 'pro' });
            return { value: true, source: 'rule', matchedRuleId: 'pro-users' };
        };
        const res = await newClient().evaluateFeatureFlag('new-dashboard', { userId: 'u1', plan: 'pro' });
        expect(res).toEqual({ value: true, source: 'rule', matchedRuleId: 'pro-users' });
    });

    it('defaults context to empty when omitted', async () => {
        flagHandlers['flag'] = ({ context }) => {
            expect(context).toEqual({});
            return { value: false, source: 'default' };
        };
        const res = await newClient().evaluateFeatureFlag('flag');
        expect(res.source).toBe('default');
    });

    it('allows per-call environment override', async () => {
        flagHandlers['flag'] = ({ environment }) => {
            expect(environment).toBe('staging');
            return { value: true, source: 'raw' };
        };
        const res = await newClient().evaluateFeatureFlag('flag', {}, 'staging');
        expect(res.value).toBe(true);
    });

    it('percent-encodes flag keys with unsafe characters', async () => {
        flagHandlers['my flag/v2'] = () => ({ value: 'ok', source: 'raw' });
        const res = await newClient().evaluateFeatureFlag('my flag/v2');
        expect(res.value).toBe('ok');
    });

    it('does not cache — second call hits the server again', async () => {
        let calls = 0;
        flagHandlers['flag'] = () => {
            calls++;
            return { value: true, source: 'rollout', rolloutBucket: 42 };
        };
        const client = newClient();
        await client.evaluateFeatureFlag('flag', { userId: 'u1' });
        await client.evaluateFeatureFlag('flag', { userId: 'u1' });
        expect(calls).toBe(2);
    });

    it('surfaces HTTP errors', async () => {
        // No handler registered → MSW falls through to the 404 default branch
        await expect(newClient().evaluateFeatureFlag('missing')).rejects.toThrow(/404/);
    });
});
