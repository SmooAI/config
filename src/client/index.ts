/* eslint-disable @typescript-eslint/no-explicit-any -- tier narrowing happens at the call site */
/**
 * `@smooai/config/client` — browser-safe config SDK.
 *
 * Mirror of `@smooai/config/server` for the browser side. Same tier shape
 * (publicConfig + featureFlag) minus `secretConfig` — secrets must never
 * ship to the browser and the type surface enforces that at compile time.
 *
 * Priority chain (public):
 *   1. Bundler-baked env vars — `NEXT_PUBLIC_CONFIG_*` (Next.js) or
 *      `VITE_CONFIG_*` (Vite). Sync, inlined at build time.
 *   2. HTTP config API — live fetch via `ConfigClient`. Async.
 *
 * Priority chain (feature flags):
 *   1. HTTP config API (async, 30s cache — always live so ops toggles flip
 *      without a rebuild).
 *   2. Bundler-baked env vars — `NEXT_PUBLIC_FEATURE_FLAG_*` / `VITE_FEATURE_FLAG_*`.
 *      Used as a fallback for offline dev or when the config server is
 *      unreachable.
 *
 * Sync variants read from the bundler-baked env vars only — no worker-thread
 * trick on the browser side. If the value isn't in the bundle, `getSync`
 * returns `undefined`. Fall through to `get` (async) for anything that may
 * not be baked.
 *
 * Note the bare helpers (`getClientPublicConfig`, `getClientFeatureFlag`,
 * `createFeatureFlagChecker`, `toUpperSnakeCase`) are still exported at
 * module scope — React hooks and legacy call sites depend on them.
 */
import { defineConfig, InferConfigTypes } from '@/config/config';
import { ConfigClient, ConfigClientOptions } from '@/platform/client';

/**
 * Convert a camelCase key to UPPER_SNAKE_CASE.
 * e.g., "aboutPage" → "ABOUT_PAGE"
 */
export function toUpperSnakeCase(key: string): string {
    return key.replace(/([A-Z])/g, '_$1').toUpperCase();
}

/**
 * Get a feature flag value from build-time environment variables.
 *
 * Checks for:
 * 1. NEXT_PUBLIC_FEATURE_FLAG_{KEY} (Next.js)
 * 2. VITE_FEATURE_FLAG_{KEY} (Vite)
 *
 * The key is converted from camelCase to UPPER_SNAKE_CASE.
 * e.g., "aboutPage" checks NEXT_PUBLIC_FEATURE_FLAG_ABOUT_PAGE
 *
 * @param key - The camelCase feature flag key
 * @returns true if the flag is explicitly set to "true", false otherwise
 */
export function getClientFeatureFlag(key: string): boolean {
    const envKey = toUpperSnakeCase(key);

    const nextValue = typeof process !== 'undefined' ? process.env?.[`NEXT_PUBLIC_FEATURE_FLAG_${envKey}`] : undefined;
    if (nextValue !== undefined) {
        return nextValue === 'true' || nextValue === '1';
    }

    const viteValue = typeof process !== 'undefined' ? process.env?.[`VITE_FEATURE_FLAG_${envKey}`] : undefined;
    if (viteValue !== undefined) {
        return viteValue === 'true' || viteValue === '1';
    }

    try {
        const viteEnv = (globalThis as Record<string, unknown>).__VITE_ENV__ as Record<string, string> | undefined;
        const viteEnvValue = viteEnv?.[`VITE_FEATURE_FLAG_${envKey}`];
        if (viteEnvValue !== undefined) {
            return viteEnvValue === 'true' || viteEnvValue === '1';
        }
    } catch {
        // Vite env not available
    }

    return false;
}

/**
 * Get a public config value from build-time environment variables.
 *
 * Checks for:
 * 1. NEXT_PUBLIC_CONFIG_{KEY} (Next.js)
 * 2. VITE_CONFIG_{KEY} (Vite)
 *
 * The key is converted from camelCase to UPPER_SNAKE_CASE.
 * e.g., "apiBaseUrl" checks NEXT_PUBLIC_CONFIG_API_BASE_URL
 *
 * @param key - The camelCase config key
 * @returns The config value as a string, or undefined if not set
 */
export function getClientPublicConfig(key: string): string | undefined {
    const envKey = toUpperSnakeCase(key);

    const nextValue = typeof process !== 'undefined' ? process.env?.[`NEXT_PUBLIC_CONFIG_${envKey}`] : undefined;
    if (nextValue !== undefined) {
        return nextValue;
    }

    const viteValue = typeof process !== 'undefined' ? process.env?.[`VITE_CONFIG_${envKey}`] : undefined;
    if (viteValue !== undefined) {
        return viteValue;
    }

    try {
        const viteEnv = (globalThis as Record<string, unknown>).__VITE_ENV__ as Record<string, string> | undefined;
        const viteEnvValue = viteEnv?.[`VITE_CONFIG_${envKey}`];
        if (viteEnvValue !== undefined) {
            return viteEnvValue;
        }
    } catch {
        // Vite env not available
    }

    return undefined;
}

/**
 * Create a typed feature flag checker from a config's FeatureFlagKeys.
 *
 * @example
 * ```tsx
 * import { createFeatureFlagChecker } from '@smooai/config/client';
 *
 * export const getFeatureFlag = createFeatureFlagChecker<typeof FeatureFlagKeys>();
 *
 * getFeatureFlag('aboutPage'); // typed to valid keys
 * ```
 */
export function createFeatureFlagChecker<T extends Record<string, string>>(): (key: T[keyof T]) => boolean {
    return (key: T[keyof T]) => getClientFeatureFlag(key as string);
}

export interface BuildClientConfigOptions {
    /** Override the ConfigClient used for HTTP-tier lookups. */
    httpClient?: ConfigClient;
    /** Options for the ConfigClient when one isn't supplied. Default cacheTtlMs: 30_000. */
    httpClientOptions?: ConfigClientOptions;
}

/**
 * Build a browser-safe config accessor with typed tier APIs.
 *
 * `publicConfig` and `featureFlag` each expose:
 *   - `get(key)`  — async; bundler env first, HTTP fallback
 *   - `getSync(key)` — synchronous bundler-baked read only; returns
 *     `undefined` if not inlined at build time
 *
 * `secretConfig` is intentionally absent: secrets don't belong in a
 * browser bundle, and this type surface enforces that. Use
 * `@smooai/config/server` on the server.
 */
export function buildClientConfig<Schema extends ReturnType<typeof defineConfig>>(schema: Schema, options?: BuildClientConfigOptions) {
    type ConfigType = InferConfigTypes<Schema>['ConfigType'];
    type PublicKey = Extract<InferConfigTypes<Schema>['PublicConfigKeys'][keyof InferConfigTypes<Schema>['PublicConfigKeys']], keyof ConfigType>;
    type FlagKey = Extract<InferConfigTypes<Schema>['FeatureFlagKeys'][keyof InferConfigTypes<Schema>['FeatureFlagKeys']], keyof ConfigType>;

    // Reference schema to satisfy the type parameter — ensures TS narrows
    // correctly even though this branch doesn't hit the schema at runtime.
    void schema;

    const httpClient = options?.httpClient ?? new ConfigClient({ cacheTtlMs: 30_000, ...(options?.httpClientOptions ?? {}) });

    async function getPublic<K extends PublicKey>(key: K): Promise<ConfigType[K] | undefined> {
        const fromBundle = getClientPublicConfig(key as string);
        if (fromBundle !== undefined) return fromBundle as unknown as ConfigType[K];

        try {
            const fromHttp = await httpClient.getValue(key as string);
            if (fromHttp !== undefined && fromHttp !== null && fromHttp !== '') return fromHttp as ConfigType[K];
        } catch {
            /* fall through */
        }
        return undefined;
    }

    async function getFlag<K extends FlagKey>(key: K): Promise<ConfigType[K] | undefined> {
        try {
            const fromHttp = await httpClient.getValue(key as string);
            if (fromHttp !== undefined && fromHttp !== null && fromHttp !== '') return fromHttp as ConfigType[K];
        } catch {
            /* fall through to bundle */
        }

        const fromBundle = getClientFeatureFlag(key as string);
        return fromBundle as unknown as ConfigType[K];
    }

    return {
        publicConfig: {
            get: getPublic,
            getSync: <K extends PublicKey>(key: K): ConfigType[K] | undefined => {
                const v = getClientPublicConfig(key as string);
                return v as unknown as ConfigType[K] | undefined;
            },
        },
        featureFlag: {
            get: getFlag,
            getSync: <K extends FlagKey>(key: K): ConfigType[K] | undefined => {
                const v = getClientFeatureFlag(key as string);
                return v as unknown as ConfigType[K] | undefined;
            },
        },
    };
}
