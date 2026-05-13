/**
 * Browser/universal HTTP client for fetching config values from the Smoo AI config server.
 *
 * Authentication uses OAuth2 `client_credentials` against `{authUrl}/token`,
 * mirroring the .NET `SmooConfigClient` and the in-package `bootstrap` /
 * `cli` flows. The exchanged JWT is cached + auto-refreshed by `TokenProvider`.
 *
 * Environment variables (used as defaults when constructor args are omitted):
 *   SMOOAI_CONFIG_API_URL        — Base URL of the config API
 *   SMOOAI_CONFIG_AUTH_URL       — OAuth issuer base URL (defaults to https://auth.smoo.ai;
 *                                  also accepts SMOOAI_AUTH_URL)
 *   SMOOAI_CONFIG_CLIENT_ID      — OAuth client ID
 *   SMOOAI_CONFIG_CLIENT_SECRET  — OAuth client secret (also accepts SMOOAI_CONFIG_API_KEY)
 *   SMOOAI_CONFIG_ORG_ID         — Organization ID
 *   SMOOAI_CONFIG_ENV            — Default environment name (e.g. "production")
 *
 * SMOODEV-602: HTTP calls route through `@smooai/fetch`, which drops in as a
 * replacement for the global `fetch` and adds retries, Retry-After honoring,
 * and clearer error surfaces. Works in both Node and browser bundles.
 *
 * SMOODEV-974: ConfigClient now exchanges client credentials for a JWT (parity
 * with bootstrap/CLI/.NET). Previously it sent the raw API key as Bearer,
 * which the smooai backend's authMiddleware rejects with 401.
 */

import fetch from '@smooai/fetch';
import { TokenProvider } from './TokenProvider';

export interface ConfigClientOptions {
    /** Base URL of the config API server. Falls back to SMOOAI_CONFIG_API_URL env var. */
    baseUrl?: string;
    /**
     * OAuth issuer base URL. Falls back to SMOOAI_CONFIG_AUTH_URL, then
     * SMOOAI_AUTH_URL env vars, then `https://auth.smoo.ai`.
     */
    authUrl?: string;
    /** OAuth client ID. Falls back to SMOOAI_CONFIG_CLIENT_ID env var. */
    clientId?: string;
    /**
     * OAuth client secret. Falls back to SMOOAI_CONFIG_CLIENT_SECRET, then
     * SMOOAI_CONFIG_API_KEY env vars. (The legacy `SMOOAI_CONFIG_API_KEY`
     * env var holds the OAuth client secret — it is NOT a Bearer token.)
     */
    clientSecret?: string;
    /** @deprecated Alias for `clientSecret`. Kept for source-level compatibility. */
    apiKey?: string;
    /** Organization ID. Falls back to SMOOAI_CONFIG_ORG_ID env var. */
    orgId?: string;
    /** Default environment name. Falls back to SMOOAI_CONFIG_ENV env var, then "development". */
    environment?: string;
    /** Cache TTL in milliseconds. 0 or undefined means cache never expires (manual invalidation only). */
    cacheTtlMs?: number;
    /**
     * Test seam — inject a pre-built `TokenProvider` so callers can stub
     * the OAuth exchange without hitting the auth server.
     */
    tokenProvider?: TokenProvider;
}

interface CacheEntry {
    value: unknown;
    expiresAt: number; // 0 = never expires
}

function getEnv(key: string): string | undefined {
    if (typeof process !== 'undefined' && process.env) {
        return process.env[key];
    }
    return undefined;
}

export class ConfigClient {
    private baseUrl: string;
    private orgId: string;
    private defaultEnvironment: string;
    private cacheTtlMs: number;
    private cache: Map<string, CacheEntry> = new Map();
    private tokenProvider: TokenProvider;

    constructor(options: ConfigClientOptions = {}) {
        const baseUrl = options.baseUrl ?? getEnv('SMOOAI_CONFIG_API_URL');
        const authUrl = options.authUrl ?? getEnv('SMOOAI_CONFIG_AUTH_URL') ?? getEnv('SMOOAI_AUTH_URL') ?? 'https://auth.smoo.ai';
        const clientId = options.clientId ?? getEnv('SMOOAI_CONFIG_CLIENT_ID');
        const clientSecret = options.clientSecret ?? options.apiKey ?? getEnv('SMOOAI_CONFIG_CLIENT_SECRET') ?? getEnv('SMOOAI_CONFIG_API_KEY');
        const orgId = options.orgId ?? getEnv('SMOOAI_CONFIG_ORG_ID');

        if (!baseUrl) throw new Error('@smooai/config: baseUrl is required (or set SMOOAI_CONFIG_API_URL)');
        if (!orgId) throw new Error('@smooai/config: orgId is required (or set SMOOAI_CONFIG_ORG_ID)');
        if (!options.tokenProvider) {
            if (!clientId) throw new Error('@smooai/config: clientId is required (or set SMOOAI_CONFIG_CLIENT_ID)');
            if (!clientSecret) throw new Error('@smooai/config: clientSecret is required (or set SMOOAI_CONFIG_CLIENT_SECRET / SMOOAI_CONFIG_API_KEY)');
        }

        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.orgId = orgId;
        this.defaultEnvironment = options.environment ?? getEnv('SMOOAI_CONFIG_ENV') ?? 'development';
        this.cacheTtlMs = options.cacheTtlMs ?? 0;
        this.tokenProvider =
            options.tokenProvider ??
            new TokenProvider({
                authUrl,
                clientId: clientId!,
                clientSecret: clientSecret!,
            });
    }

    private computeExpiresAt(): number {
        return this.cacheTtlMs > 0 ? Date.now() + this.cacheTtlMs : 0;
    }

    private getCached(cacheKey: string): unknown | undefined {
        const entry = this.cache.get(cacheKey);
        if (!entry) return undefined;
        if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
            this.cache.delete(cacheKey);
            return undefined;
        }
        return entry.value;
    }

    private async authHeader(): Promise<string> {
        return `Bearer ${await this.tokenProvider.getAccessToken()}`;
    }

    private async fetchJson<T>(path: string, fetchOptions?: RequestInit): Promise<T> {
        const send = async (): Promise<Response> =>
            fetch(`${this.baseUrl}${path}`, {
                ...fetchOptions,
                headers: { Authorization: await this.authHeader(), ...fetchOptions?.headers },
            });

        try {
            const response = await send();
            if (!response.ok) {
                throw new Error(`Config API error: HTTP ${response.status} ${response.statusText}`);
            }
            return response.json() as Promise<T>;
        } catch (err) {
            // @smooai/fetch throws HTTPResponseError on non-2xx, exposing the response on `.response`.
            // If we got a 401, the cached OAuth token may have been revoked/rotated — drop it and retry once.
            const status = (err as { response?: { status?: number } } | undefined)?.response?.status;
            if (status === 401) {
                this.tokenProvider.invalidate();
                const response = await send();
                if (!response.ok) {
                    throw new Error(`Config API error: HTTP ${response.status} ${response.statusText}`);
                }
                return response.json() as Promise<T>;
            }
            throw err;
        }
    }

    /**
     * Get a single config value by key.
     * Results are cached locally after the first fetch.
     */
    async getValue(key: string, environment?: string): Promise<unknown> {
        const env = environment ?? this.defaultEnvironment;
        const cacheKey = `${env}:${key}`;

        const cached = this.getCached(cacheKey);
        if (cached !== undefined) {
            return cached;
        }

        const result = await this.fetchJson<{ value: unknown }>(
            `/organizations/${this.orgId}/config/values/${encodeURIComponent(key)}?environment=${encodeURIComponent(env)}`,
        );
        this.cache.set(cacheKey, { value: result.value, expiresAt: this.computeExpiresAt() });
        return result.value;
    }

    /**
     * Get all config values for an environment.
     * All returned values are cached locally.
     * @param environment - Environment name (defaults to constructor option or SMOOAI_CONFIG_ENV)
     * @param fetchOptions - Optional fetch options (e.g., Next.js `{ next: { revalidate: 60 } }`)
     */
    async getAllValues(environment?: string, fetchOptions?: RequestInit): Promise<Record<string, unknown>> {
        const env = environment ?? this.defaultEnvironment;

        const result = await this.fetchJson<{ values: Record<string, unknown> }>(
            `/organizations/${this.orgId}/config/values?environment=${encodeURIComponent(env)}`,
            fetchOptions,
        );

        const expiresAt = this.computeExpiresAt();
        for (const [key, value] of Object.entries(result.values)) {
            this.cache.set(`${env}:${key}`, { value, expiresAt });
        }

        return result.values;
    }

    /**
     * Pre-populate a single cache entry (e.g., from SSR).
     * Does not make a network request.
     */
    seedCache(key: string, value: unknown, environment?: string): void {
        const env = environment ?? this.defaultEnvironment;
        this.cache.set(`${env}:${key}`, { value, expiresAt: this.computeExpiresAt() });
    }

    /**
     * Pre-populate multiple cache entries from a key-value map (e.g., from SSR).
     * Does not make a network request.
     */
    seedCacheFromMap(values: Record<string, unknown>, environment?: string): void {
        const env = environment ?? this.defaultEnvironment;
        const expiresAt = this.computeExpiresAt();
        for (const [key, value] of Object.entries(values)) {
            this.cache.set(`${env}:${key}`, { value, expiresAt });
        }
    }

    /**
     * Synchronously read a value from the local cache without making a network request.
     * Returns `undefined` if the key is not cached or has expired.
     */
    getCachedValue(key: string, environment?: string): unknown | undefined {
        const env = environment ?? this.defaultEnvironment;
        return this.getCached(`${env}:${key}`);
    }

    /** Clear the entire local cache. */
    invalidateCache(): void {
        this.cache.clear();
    }

    /** Clear cached values for a specific environment. */
    invalidateCacheForEnvironment(environment: string): void {
        const prefix = `${environment}:`;
        for (const key of this.cache.keys()) {
            if (key.startsWith(prefix)) {
                this.cache.delete(key);
            }
        }
    }

    /**
     * Evaluate a segment-aware feature flag against the server.
     *
     * Unlike `getValue` / `getCachedValue`, this is always a network call:
     * segment rules (percentage rollout, attribute matching, bucketing) live
     * server-side and the response depends on the `context` you pass. Callers
     * that don't need segment evaluation should keep using `getValue` for the
     * static flag value.
     *
     * @param key - Feature-flag key.
     * @param context - Attributes the server's segment rules may reference
     *   (e.g. `{ userId, tenantId, plan, country }`). Unreferenced keys are
     *   ignored by the server. Keep values JSON-serializable — the server
     *   hashes `bucketBy` values by their string representation, so numbers
     *   and booleans bucket stably across client rebuilds.
     * @param environment - Environment name (defaults to the client's default).
     */
    async evaluateFeatureFlag(key: string, context: Record<string, unknown> = {}, environment?: string): Promise<EvaluateFeatureFlagResponse> {
        const env = environment ?? this.defaultEnvironment;
        const url = `${this.baseUrl}/organizations/${this.orgId}/config/feature-flags/${encodeURIComponent(key)}/evaluate`;
        const send = async (): Promise<Response> =>
            fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: await this.authHeader(),
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ environment: env, context }),
            });

        const dispatchOrThrow = async (response: Response): Promise<EvaluateFeatureFlagResponse> => {
            if (response.status === 404) {
                throw new FeatureFlagNotFoundError(key);
            }
            if (response.status === 400) {
                const text = await response.text().catch(() => '');
                throw new FeatureFlagContextError(key, text);
            }
            if (!response.ok) {
                const text = await response.text().catch(() => '');
                throw new FeatureFlagEvaluationError(key, response.status, text);
            }
            return (await response.json()) as EvaluateFeatureFlagResponse;
        };

        try {
            const response = await send();
            return await dispatchOrThrow(response);
        } catch (err) {
            // @smooai/fetch wraps non-2xx as HTTPResponseError. Translate to the
            // typed FeatureFlag* errors so callers can branch on subclass,
            // and retry once on 401 with a fresh OAuth token.
            const inner = err as { response?: Response & { status?: number; isJson?: boolean; data?: { message?: string }; dataString?: string } };
            const status = inner?.response?.status;
            if (status === undefined) throw err; // not an HTTPResponseError — propagate
            if (status === 401) {
                this.tokenProvider.invalidate();
                const response = await send();
                try {
                    return await dispatchOrThrow(response);
                } catch (innerErr) {
                    const r = (innerErr as { response?: { status?: number; dataString?: string; data?: { message?: string } } }).response;
                    if (r?.status === undefined) throw innerErr;
                    return throwFlagError(key, r.status, r.dataString ?? r.data?.message);
                }
            }
            return throwFlagError(key, status, inner.response?.dataString ?? inner.response?.data?.message);
        }
    }
}

function throwFlagError(key: string, status: number, body?: string): never {
    if (status === 404) throw new FeatureFlagNotFoundError(key);
    if (status === 400) throw new FeatureFlagContextError(key, body);
    throw new FeatureFlagEvaluationError(key, status, body);
}

/**
 * Response from the server-side feature-flag evaluator. Matches the wire
 * contract defined in `@smooai/schemas/config/feature-flag`.
 */
export interface EvaluateFeatureFlagResponse {
    /** The resolved flag value (post rules + rollout). */
    value: unknown;
    /** Id of the rule that fired, if any. */
    matchedRuleId?: string;
    /** 0–99 bucket the context was assigned to, if a rollout ran. */
    rolloutBucket?: number;
    /** Which branch the evaluator returned from. */
    source: 'raw' | 'rule' | 'rollout' | 'default';
}

/**
 * Base class for errors thrown by `evaluateFeatureFlag`. Subclasses let
 * callers branch on 404 / 400 / 5xx without parsing messages.
 */
export class FeatureFlagEvaluationError extends Error {
    constructor(
        public readonly key: string,
        public readonly statusCode: number,
        public readonly serverMessage?: string,
    ) {
        super(`Feature flag "${key}" evaluation failed: HTTP ${statusCode}${serverMessage ? ` — ${serverMessage}` : ''}`);
        this.name = 'FeatureFlagEvaluationError';
    }
}

/** Server returned 404 — the flag key is not defined in the org's schema. */
export class FeatureFlagNotFoundError extends FeatureFlagEvaluationError {
    constructor(key: string) {
        super(key, 404, 'flag not defined in schema');
        this.name = 'FeatureFlagNotFoundError';
    }
}

/** Server returned 400 — invalid context or missing environment. */
export class FeatureFlagContextError extends FeatureFlagEvaluationError {
    constructor(key: string, serverMessage?: string) {
        super(key, 400, serverMessage ?? 'invalid context or environment');
        this.name = 'FeatureFlagContextError';
    }
}
