/**
 * @smooai/config/bootstrap — lightweight cold-start config fetcher.
 *
 * This entry point exists for callers that need to read a single config
 * value from a script, build step, or other cold-start context where
 * importing the full @smooai/config SDK is too expensive or pulls in a
 * transitive dependency (e.g. `@smooai/logger`'s top-level
 * `import.meta.url` use) that breaks the host runtime (tsx, edge, etc.).
 *
 * It deliberately has **zero** imports from the rest of @smooai/config
 * and zero third-party dependencies. Only Node built-ins (`process`,
 * native `fetch`) are used.
 *
 * It performs a single OAuth `client_credentials` exchange, then a single
 * GET against `/organizations/{orgId}/config/values?environment={env}`.
 * The resulting values map is cached per-process per-env so repeated
 * reads inside the same script avoid the round-trip.
 *
 * Inputs (read from `process.env`):
 *   SMOOAI_CONFIG_API_URL       base URL (default https://api.smoo.ai)
 *   SMOOAI_CONFIG_AUTH_URL      OAuth base URL (default https://auth.smoo.ai;
 *                               legacy SMOOAI_AUTH_URL also accepted)
 *   SMOOAI_CONFIG_CLIENT_ID     OAuth M2M client id
 *   SMOOAI_CONFIG_CLIENT_SECRET OAuth M2M client secret
 *                               (legacy SMOOAI_CONFIG_API_KEY accepted)
 *   SMOOAI_CONFIG_ORG_ID        target org id
 *   SMOOAI_CONFIG_ENV           default env name (used when `options.environment`
 *                               is omitted and no SST stage is detected)
 *
 * Environment resolution order (when `options.environment` is omitted):
 *   1. SST_STAGE
 *   2. NEXT_PUBLIC_SST_STAGE
 *   3. SST_RESOURCE_App (JSON, `.stage` field — `sst shell` exports this
 *      even when SST_STAGE itself isn't set)
 *   4. SMOOAI_CONFIG_ENV
 *   5. 'development'
 *
 * Stage-to-env follows the platform convention: `production` stays
 * `production`, anything else uses the stage value directly (or the
 * SMOOAI_CONFIG_ENV fallback when no stage is detected).
 */

export interface BootstrapOptions {
    /** Explicit environment name. Bypasses auto-detection. */
    environment?: string;
}

interface BootstrapCreds {
    apiUrl: string;
    authUrl: string;
    clientId: string;
    clientSecret: string;
    orgId: string;
}

function readCreds(): BootstrapCreds {
    const apiUrl = process.env.SMOOAI_CONFIG_API_URL ?? 'https://api.smoo.ai';
    const authUrl = process.env.SMOOAI_CONFIG_AUTH_URL ?? process.env.SMOOAI_AUTH_URL ?? 'https://auth.smoo.ai';
    const clientId = process.env.SMOOAI_CONFIG_CLIENT_ID;
    const clientSecret = process.env.SMOOAI_CONFIG_CLIENT_SECRET || process.env.SMOOAI_CONFIG_API_KEY;
    const orgId = process.env.SMOOAI_CONFIG_ORG_ID;
    if (!clientId || !clientSecret || !orgId) {
        throw new Error(
            '[@smooai/config/bootstrap] missing SMOOAI_CONFIG_{CLIENT_ID,CLIENT_SECRET,ORG_ID} in env. ' +
                'Set these (e.g. via `pnpm sst shell --stage <stage>`) before calling bootstrapFetch.',
        );
    }
    return { apiUrl, authUrl, clientId, clientSecret, orgId };
}

async function mintAccessToken(creds: BootstrapCreds): Promise<string> {
    const trimmedAuth = creds.authUrl.replace(/\/+$/, '');
    const res = await fetch(`${trimmedAuth}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'client_credentials',
            provider: 'client_credentials',
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
        }).toString(),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '<unreadable>');
        throw new Error(`[@smooai/config/bootstrap] OAuth token exchange failed: HTTP ${res.status} ${body}`);
    }
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) {
        throw new Error('[@smooai/config/bootstrap] OAuth token endpoint returned no access_token');
    }
    return body.access_token;
}

function resolveEnv(environment?: string): string {
    if (environment) return environment;
    let stage = process.env.SST_STAGE ?? process.env.NEXT_PUBLIC_SST_STAGE;
    if (!stage) {
        try {
            const raw = process.env.SST_RESOURCE_App;
            if (raw) {
                const parsed = JSON.parse(raw) as { stage?: string };
                if (parsed.stage) stage = parsed.stage;
            }
        } catch {
            // fall through
        }
    }
    if (!stage) {
        return process.env.SMOOAI_CONFIG_ENV ?? 'development';
    }
    if (stage === 'production') return 'production';
    return stage;
}

let cached: Record<string, unknown> | undefined;
let cachedEnv: string | undefined;

/** Test-only: clear the in-process values cache. Not part of the public API. */
export function resetBootstrapCacheForTests(): void {
    cached = undefined;
    cachedEnv = undefined;
}

/**
 * Fetch a single config value by camelCase key. The full values map is
 * cached per-process per-env after the first call so repeated reads in
 * the same script process don't re-do the OAuth + GET round-trip.
 *
 * Returns `undefined` if the key is not present in the values map. Does
 * NOT throw on missing keys — only on env/auth/network errors.
 */
export async function bootstrapFetch(key: string, options?: BootstrapOptions): Promise<string | undefined> {
    const env = resolveEnv(options?.environment);
    if (cached === undefined || cachedEnv !== env) {
        const creds = readCreds();
        const token = await mintAccessToken(creds);
        const trimmedApi = creds.apiUrl.replace(/\/+$/, '');
        const url = `${trimmedApi}/organizations/${encodeURIComponent(creds.orgId)}/config/values?environment=${encodeURIComponent(env)}`;
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '<unreadable>');
            throw new Error(`[@smooai/config/bootstrap] GET /config/values failed: HTTP ${res.status} ${body}`);
        }
        const body = (await res.json()) as { values?: Record<string, unknown> };
        cached = body.values ?? {};
        cachedEnv = env;
    }
    const v = cached[key];
    if (v === undefined || v === null) return undefined;
    return typeof v === 'string' ? v : String(v);
}
