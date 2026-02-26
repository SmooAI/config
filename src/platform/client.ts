/**
 * Browser/universal HTTP client for fetching config values from the Smoo AI config server.
 *
 * Environment variables (optional — used as defaults when constructor args are omitted):
 *   SMOOAI_CONFIG_API_URL  — Base URL of the config API
 *   SMOOAI_CONFIG_API_KEY  — Bearer token for authentication
 *   SMOOAI_CONFIG_ORG_ID   — Organization ID
 *   SMOOAI_CONFIG_ENV      — Default environment name (e.g. "production")
 */

import fetch from '@smooai/fetch';

export interface ConfigClientOptions {
    /** Base URL of the config API server. Falls back to SMOOAI_CONFIG_API_URL env var. */
    baseUrl?: string;
    /** API key (M2M / client credentials token). Falls back to SMOOAI_CONFIG_API_KEY env var. */
    apiKey?: string;
    /** Organization ID. Falls back to SMOOAI_CONFIG_ORG_ID env var. */
    orgId?: string;
    /** Default environment name. Falls back to SMOOAI_CONFIG_ENV env var, then "development". */
    environment?: string;
    /** Cache TTL in milliseconds. 0 or undefined means cache never expires (manual invalidation only). */
    cacheTtlMs?: number;
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
    private apiKey: string;
    private defaultEnvironment: string;
    private cacheTtlMs: number;
    private cache: Map<string, CacheEntry> = new Map();

    constructor(options: ConfigClientOptions = {}) {
        const baseUrl = options.baseUrl ?? getEnv('SMOOAI_CONFIG_API_URL');
        const apiKey = options.apiKey ?? getEnv('SMOOAI_CONFIG_API_KEY');
        const orgId = options.orgId ?? getEnv('SMOOAI_CONFIG_ORG_ID');

        if (!baseUrl) throw new Error('@smooai/config: baseUrl is required (or set SMOOAI_CONFIG_API_URL)');
        if (!apiKey) throw new Error('@smooai/config: apiKey is required (or set SMOOAI_CONFIG_API_KEY)');
        if (!orgId) throw new Error('@smooai/config: orgId is required (or set SMOOAI_CONFIG_ORG_ID)');

        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.apiKey = apiKey;
        this.orgId = orgId;
        this.defaultEnvironment = options.environment ?? getEnv('SMOOAI_CONFIG_ENV') ?? 'development';
        this.cacheTtlMs = options.cacheTtlMs ?? 0;
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

    private async fetchJson<T>(path: string, fetchOptions?: RequestInit): Promise<T> {
        const response = await fetch(`${this.baseUrl}${path}`, {
            ...fetchOptions,
            headers: { Authorization: `Bearer ${this.apiKey}`, ...fetchOptions?.headers },
        });
        if (!response.ok) {
            throw new Error(`Config API error: HTTP ${response.status} ${response.statusText}`);
        }
        return response.json() as Promise<T>;
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
}
