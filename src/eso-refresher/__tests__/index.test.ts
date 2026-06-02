import { ConfigBootstrapError } from '@/container/errors';
import type { TokenProvider } from '@/platform/TokenProvider';
/**
 * SMOODEV-1523 — ESO bearer-token refresher unit tests.
 *
 * Exercises the refresh loop without a live cluster or auth server by injecting
 * a fake `TokenProvider` and `SecretWriter` and a controllable scheduler.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runEsoRefresher, type SecretWriter } from '../index';

function fakeTokenProvider(tokens: string[]): { tp: TokenProvider; invalidations: () => number; calls: () => number } {
    let i = 0;
    let invalidations = 0;
    let calls = 0;
    const tp = {
        getAccessToken: vi.fn(async () => {
            calls++;
            // Hand out a new token each call so we can assert freshness.
            return tokens[Math.min(i++, tokens.length - 1)];
        }),
        invalidate: vi.fn(() => {
            invalidations++;
        }),
    } as unknown as TokenProvider;
    return { tp, invalidations: () => invalidations, calls: () => calls };
}

function recordingWriter(): { writer: SecretWriter; written: string[]; fail: (n: number) => void } {
    const written: string[] = [];
    let failOnCall = -1;
    let call = 0;
    const writer: SecretWriter = {
        patchBearerToken: vi.fn(async (token: string) => {
            call++;
            if (call === failOnCall) throw new Error('simulated k8s patch failure');
            written.push(token);
        }),
    };
    return { writer, written, fail: (n) => (failOnCall = n) };
}

/** Captures the scheduled tick fn so tests can drive it deterministically. */
function manualScheduler(): {
    scheduler: (fn: () => void, ms: number) => { clear: () => void };
    tick: () => void;
    cleared: () => boolean;
    intervalMs: () => number;
} {
    let captured: (() => void) | undefined;
    let cleared = false;
    let intervalMs = 0;
    return {
        scheduler: (fn, ms) => {
            captured = fn;
            intervalMs = ms;
            return { clear: () => (cleared = true) };
        },
        tick: () => captured?.(),
        cleared: () => cleared,
        intervalMs: () => intervalMs,
    };
}

describe('runEsoRefresher (SMOODEV-1523)', () => {
    beforeEach(() => vi.clearAllMocks());

    it('mints and writes the bearer token at startup (fail-loud initial sync)', async () => {
        const { tp } = fakeTokenProvider(['tok-1']);
        const { writer, written } = recordingWriter();
        const sched = manualScheduler();

        await runEsoRefresher({ tokenProvider: tp, secretWriter: writer, scheduler: sched.scheduler });

        expect(written).toEqual(['tok-1']);
    });

    it('throws ConfigBootstrapError when client credentials are missing and no provider injected', async () => {
        const prevId = process.env.SMOOAI_CONFIG_CLIENT_ID;
        const prevSecret = process.env.SMOOAI_CONFIG_CLIENT_SECRET;
        const prevApiKey = process.env.SMOOAI_CONFIG_API_KEY;
        delete process.env.SMOOAI_CONFIG_CLIENT_ID;
        delete process.env.SMOOAI_CONFIG_CLIENT_SECRET;
        delete process.env.SMOOAI_CONFIG_API_KEY;
        try {
            await expect(runEsoRefresher({ secretWriter: recordingWriter().writer })).rejects.toBeInstanceOf(ConfigBootstrapError);
        } finally {
            if (prevId !== undefined) process.env.SMOOAI_CONFIG_CLIENT_ID = prevId;
            if (prevSecret !== undefined) process.env.SMOOAI_CONFIG_CLIENT_SECRET = prevSecret;
            if (prevApiKey !== undefined) process.env.SMOOAI_CONFIG_API_KEY = prevApiKey;
        }
    });

    it('forces a fresh token each cycle (invalidate before every mint)', async () => {
        const { tp, invalidations, calls } = fakeTokenProvider(['tok-1', 'tok-2', 'tok-3']);
        const { writer, written } = recordingWriter();
        const sched = manualScheduler();

        await runEsoRefresher({ tokenProvider: tp, secretWriter: writer, scheduler: sched.scheduler });
        sched.tick();
        await vi.waitFor(() => expect(written).toHaveLength(2));

        // Startup + one tick = two mints, each preceded by an invalidate.
        expect(calls()).toBe(2);
        expect(invalidations()).toBe(2);
        expect(written).toEqual(['tok-1', 'tok-2']);
    });

    it('survives a tick failure and keeps refreshing on later ticks', async () => {
        const { tp } = fakeTokenProvider(['tok-1', 'tok-2', 'tok-3']);
        const { writer, written, fail } = recordingWriter();
        const sched = manualScheduler();
        fail(2); // second patch (first scheduled tick) throws

        await runEsoRefresher({ tokenProvider: tp, secretWriter: writer, scheduler: sched.scheduler });
        sched.tick(); // fails internally, must not throw out of the loop
        sched.tick(); // recovers
        await vi.waitFor(() => expect(written).toEqual(['tok-1', 'tok-3']));
    });

    it('stop() clears the scheduled loop', async () => {
        const { tp } = fakeTokenProvider(['tok-1']);
        const { writer } = recordingWriter();
        const sched = manualScheduler();

        const handle = await runEsoRefresher({ tokenProvider: tp, secretWriter: writer, scheduler: sched.scheduler });
        expect(sched.cleared()).toBe(false);
        handle.stop();
        expect(sched.cleared()).toBe(true);
    });

    it('honors an explicit interval override', async () => {
        const { tp } = fakeTokenProvider(['tok-1']);
        const { writer } = recordingWriter();
        const sched = manualScheduler();

        await runEsoRefresher({ tokenProvider: tp, secretWriter: writer, scheduler: sched.scheduler, intervalMs: 12345 });
        expect(sched.intervalMs()).toBe(12345);
    });
});
