import { defineConfig, StringSchema } from '@/config/config';
import { ConfigClient } from '@/platform/client';
import { TokenProvider } from '@/platform/TokenProvider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSelectModeLogForTests, ConfigBootstrapError, configHealth, ConfigKeyUnresolvedError, initContainerConfig, selectMode } from '../index';

// Mock @smooai/fetch so ConfigClient/TokenProvider never hit the network.
const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock('@smooai/fetch', () => ({ default: mockFetch }));

// A minimal schema with one secret + one public + one flag.
const schema = defineConfig({
    publicConfigSchema: { apiBaseUrl: StringSchema },
    secretConfigSchema: { stripeApiKey: StringSchema, sendgridApiKey: StringSchema },
    featureFlagSchema: { newCheckout: StringSchema },
});

/** A TokenProvider that returns a fixed JWT without an OAuth round-trip. */
class StubTokenProvider extends TokenProvider {
    public invalidateCallCount = 0;
    constructor(private readonly token: string = 'test-token') {
        super({ authUrl: 'https://stub.invalid', clientId: 'id', clientSecret: 'secret' });
    }
    async getAccessToken(): Promise<string> {
        return this.token;
    }
    invalidate(): void {
        this.invalidateCallCount++;
        super.invalidate();
    }
}

function makeClient(tokenProvider?: TokenProvider): ConfigClient {
    return new ConfigClient({
        baseUrl: 'https://api.smooai.test',
        orgId: 'org-1',
        environment: 'production',
        cacheTtlMs: 30_000,
        tokenProvider: tokenProvider ?? new StubTokenProvider(),
    });
}

/** Queue mock fetch responses (FIFO). */
function queueFetch(responses: Array<{ ok?: boolean; status?: number; json?: unknown; text?: string }>) {
    mockFetch.mockReset();
    for (const r of responses) {
        const ok = r.ok ?? true;
        const status = r.status ?? (ok ? 200 : 500);
        mockFetch.mockResolvedValueOnce({
            ok,
            status,
            statusText: ok ? 'OK' : 'ERR',
            json: async () => r.json,
            text: async () => r.text ?? JSON.stringify(r.json),
        });
    }
}

const ORIGINAL_ENV = { ...process.env };
// Schema-key env names that the env tier would read. Cleared per-test so a
// host shell that happens to export e.g. SENDGRID_API_KEY can't leak into the
// env tier and break isolation.
const SCHEMA_KEY_ENV = ['STRIPE_API_KEY', 'SENDGRID_API_KEY', 'API_BASE_URL', 'NEW_CHECKOUT'];
function clearSmooEnv() {
    for (const k of Object.keys(process.env)) {
        if (k.startsWith('SMOOAI_') || k.startsWith('SMOO_CONFIG')) delete process.env[k];
    }
    for (const k of SCHEMA_KEY_ENV) delete process.env[k];
}

beforeEach(() => {
    clearSmooEnv();
    mockFetch.mockReset();
    __resetSelectModeLogForTests();
});

afterEach(() => {
    for (const k of Object.keys(process.env)) {
        if (!(k in ORIGINAL_ENV)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(ORIGINAL_ENV)) process.env[k] = v;
});

describe('initContainerConfig — bootstrap validation', () => {
    it('throws ConfigBootstrapError listing every missing required env var', async () => {
        // No env set, no injected client.
        const err = await initContainerConfig({ schema }).catch((e) => e);
        expect(err).toBeInstanceOf(ConfigBootstrapError);
        expect(err.missing).toEqual(
            expect.arrayContaining([
                'SMOOAI_CONFIG_API_URL',
                'SMOOAI_CONFIG_CLIENT_ID',
                'SMOOAI_CONFIG_CLIENT_SECRET',
                'SMOOAI_CONFIG_ORG_ID',
                'SMOOAI_CONFIG_ENV',
            ]),
        );
        expect(err.message).toContain('SMOOAI_CONFIG_API_URL');
    });

    it('lists only the actually-missing vars (partial env)', async () => {
        process.env.SMOOAI_CONFIG_API_URL = 'https://api.smooai.test';
        process.env.SMOOAI_CONFIG_CLIENT_ID = 'id';
        process.env.SMOOAI_CONFIG_ORG_ID = 'org-1';
        process.env.SMOOAI_CONFIG_ENV = 'production';
        // CLIENT_SECRET missing.
        const err = await initContainerConfig({ schema }).catch((e) => e);
        expect(err).toBeInstanceOf(ConfigBootstrapError);
        expect(err.missing).toEqual(['SMOOAI_CONFIG_CLIENT_SECRET']);
    });

    it('treats a blank (whitespace) env var as missing', async () => {
        process.env.SMOOAI_CONFIG_API_URL = 'https://api.smooai.test';
        process.env.SMOOAI_CONFIG_CLIENT_ID = '   ';
        process.env.SMOOAI_CONFIG_CLIENT_SECRET = 'secret';
        process.env.SMOOAI_CONFIG_ORG_ID = 'org-1';
        process.env.SMOOAI_CONFIG_ENV = 'production';
        const err = await initContainerConfig({ schema }).catch((e) => e);
        expect(err).toBeInstanceOf(ConfigBootstrapError);
        expect(err.missing).toEqual(['SMOOAI_CONFIG_CLIENT_ID']);
    });

    it('accepts legacy SMOOAI_CONFIG_API_KEY as the client secret', async () => {
        process.env.SMOOAI_CONFIG_API_URL = 'https://api.smooai.test';
        process.env.SMOOAI_CONFIG_CLIENT_ID = 'id';
        process.env.SMOOAI_CONFIG_API_KEY = 'legacy-secret';
        process.env.SMOOAI_CONFIG_ORG_ID = 'org-1';
        process.env.SMOOAI_CONFIG_ENV = 'production';
        // token mint + initial getAllValues
        queueFetch([{ json: { access_token: 'T', expires_in: 3600 } }, { json: { values: {} } }]);
        const handle = await initContainerConfig({ schema });
        expect(handle).toBeDefined();
    });

    it('with an injected ConfigClient, only SMOOAI_CONFIG_ENV is required', async () => {
        const err = await initContainerConfig({ schema, configClient: makeClient() }).catch((e) => e);
        expect(err).toBeInstanceOf(ConfigBootstrapError);
        expect(err.missing).toEqual(['SMOOAI_CONFIG_ENV']);
    });
});

describe('initContainerConfig — startup fetch (fail at boot, not first read)', () => {
    it('throws when the initial config fetch fails (no silent degraded start)', async () => {
        // initial getAllValues -> 500
        queueFetch([{ ok: false, status: 500, text: 'boom' }]);
        const err = await initContainerConfig({
            schema,
            environment: 'production',
            configClient: makeClient(),
        }).catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        expect(String(err)).toMatch(/500/);
    });

    it('happy path: initial fetch succeeds and a value reads from cache without a 2nd HTTP call', async () => {
        // initial getAllValues returns the full map.
        queueFetch([{ json: { values: { stripeApiKey: 'sk_live_123', apiBaseUrl: 'https://x' } } }]);
        const handle = await initContainerConfig({ schema, environment: 'production', configClient: makeClient() });
        const callsAfterInit = mockFetch.mock.calls.length;
        expect(await handle.secretConfig.get('stripeApiKey')).toBe('sk_live_123');
        expect(await handle.publicConfig.get('apiBaseUrl')).toBe('https://x');
        // getAllValues seeded the cache, so no extra fetches.
        expect(mockFetch.mock.calls.length).toBe(callsAfterInit);
    });
});

describe('fail-loud reads (§3)', () => {
    it('required secret unresolved -> throws ConfigKeyUnresolvedError (not undefined)', async () => {
        // initial getAllValues: empty. Then per-key getValue for the missing key -> {value: undefined}.
        queueFetch([{ json: { values: {} } }, { json: { value: undefined } }]);
        const handle = await initContainerConfig({ schema, environment: 'production', configClient: makeClient() });
        const err = await handle.secretConfig.get('stripeApiKey').catch((e) => e);
        expect(err).toBeInstanceOf(ConfigKeyUnresolvedError);
        expect(err.key).toBe('stripeApiKey');
        expect(err.env).toBe('production');
        expect(err.triedTiers).toEqual(['env', 'http']);
    });

    it('optional key absent -> returns undefined, does NOT throw', async () => {
        queueFetch([{ json: { values: {} } }, { json: { value: undefined } }]);
        const handle = await initContainerConfig({
            schema,
            environment: 'production',
            configClient: makeClient(),
            optionalKeys: ['sendgridApiKey'],
        });
        await expect(handle.secretConfig.get('sendgridApiKey')).resolves.toBeUndefined();
    });

    it('getSync for an unresolved required key throws (no silent undefined)', async () => {
        queueFetch([{ json: { values: {} } }]);
        const handle = await initContainerConfig({ schema, environment: 'production', configClient: makeClient() });
        expect(() => handle.secretConfig.getSync('stripeApiKey')).toThrow(ConfigKeyUnresolvedError);
    });

    it('getSync returns a cached value when present', async () => {
        queueFetch([{ json: { values: { stripeApiKey: 'sk_cached' } } }]);
        const handle = await initContainerConfig({ schema, environment: 'production', configClient: makeClient() });
        expect(handle.secretConfig.getSync('stripeApiKey')).toBe('sk_cached');
    });

    it('an explicit process env override wins over HTTP (env tier precedence)', async () => {
        process.env.STRIPE_API_KEY = 'sk_from_env';
        queueFetch([{ json: { values: { stripeApiKey: 'sk_from_http' } } }]);
        const handle = await initContainerConfig({ schema, environment: 'production', configClient: makeClient() });
        expect(await handle.secretConfig.get('stripeApiKey')).toBe('sk_from_env');
    });
});

describe('401 -> refresh -> retry (§5)', () => {
    it('invalidates the token and retries once on a 401', async () => {
        const tp = new StubTokenProvider();
        const client = makeClient(tp);
        // initial getAllValues ok (empty)
        // then per-key getValue: 401 (triggers invalidate+retry), then 200.
        queueFetch([{ json: { values: {} } }, { ok: false, status: 401, text: 'expired' }, { json: { value: 'sk_after_refresh' } }]);
        // @smooai/fetch throws on non-2xx with err.response.status — emulate that
        // for the 401 by making the 2nd call reject.
        mockFetch.mockReset();
        mockFetch
            .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ values: {} }) })
            .mockRejectedValueOnce(Object.assign(new Error('HTTP 401'), { response: { status: 401 } }))
            .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ value: 'sk_after_refresh' }) });

        const handle = await initContainerConfig({ schema, environment: 'production', configClient: client });
        const v = await handle.secretConfig.get('stripeApiKey');
        expect(v).toBe('sk_after_refresh');
        expect(tp.invalidateCallCount).toBe(1);
    });
});

describe('configHealth (§4)', () => {
    it('reports healthy after a successful initial fetch', async () => {
        queueFetch([{ json: { values: { stripeApiKey: 'sk' } } }]);
        const handle = await initContainerConfig({ schema, environment: 'production', configClient: makeClient() });
        expect(handle.health()).toEqual({ status: 'healthy' });
        expect(configHealth(handle)).toEqual({ status: 'healthy' });
    });

    it('serves healthy on a background refresh failure within TTL, unhealthy past hard-expiry', async () => {
        vi.useFakeTimers();
        try {
            // initial getAllValues seeds stripeApiKey.
            mockFetch.mockReset();
            mockFetch
                .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ values: { stripeApiKey: 'sk_initial' } }) })
                // subsequent getValue refresh fails.
                .mockRejectedValue(Object.assign(new Error('network down'), { response: { status: 503 } }));

            const handle = await initContainerConfig({
                schema,
                environment: 'production',
                configClient: makeClient(),
                cacheTtlMs: 30_000,
            });
            expect(handle.health()).toEqual({ status: 'healthy' });

            // Force a refresh failure by reading after the per-key cache expires.
            // The cached value from getAllValues is still served (last-good).
            vi.advanceTimersByTime(31_000); // expire the per-key TTL cache
            const v = await handle.secretConfig.get('stripeApiKey').catch((e) => e);
            // last-good cache is gone (TTL expired) AND http failed -> unresolved required.
            expect(v).toBeInstanceOf(ConfigKeyUnresolvedError);

            // Health: last refresh failed and we're past the TTL window -> unhealthy.
            const h = handle.health();
            expect(h.status).toBe('unhealthy');
            if (h.status === 'unhealthy') expect(h.reason).toMatch(/network down|TTL/);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('selectMode (§2)', () => {
    it('SMOOAI_CONFIG_MODE=container forces container mode', () => {
        expect(selectMode({ mode: 'container' })).toBe('container');
        expect(selectMode({ mode: 'CONTAINER' })).toBe('container');
    });

    it('a present blob source means default mode (not container)', () => {
        expect(selectMode({ blobPresent: true, clientId: 'id', clientSecret: 's', apiUrl: 'u' })).toBe('default');
    });

    it('a present file source means default mode', () => {
        expect(selectMode({ filePresent: true, clientId: 'id', clientSecret: 's', apiUrl: 'u' })).toBe('default');
    });

    it('auto-selects container when CLIENT_ID + CLIENT_SECRET + API_URL set and no blob/file', () => {
        expect(selectMode({ clientId: 'id', clientSecret: 's', apiUrl: 'u' })).toBe('container');
    });

    it('falls back to default when the M2M creds are incomplete', () => {
        expect(selectMode({ clientId: 'id', apiUrl: 'u' })).toBe('default');
        expect(selectMode({})).toBe('default');
    });

    it('reads from process.env when inputs are omitted', () => {
        process.env.SMOOAI_CONFIG_MODE = 'container';
        expect(selectMode()).toBe('container');
    });
});
