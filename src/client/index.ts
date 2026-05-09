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
import { ConfigClient, ConfigClientOptions, EvaluateFeatureFlagResponse } from '@/platform/client';

export type { EvaluateFeatureFlagResponse } from '@/platform/client';
export { FeatureFlagContextError, FeatureFlagEvaluationError, FeatureFlagNotFoundError } from '@/platform/client';

/**
 * Convert a camelCase key to UPPER_SNAKE_CASE.
 * e.g., "aboutPage" → "ABOUT_PAGE"
 */
export function toUpperSnakeCase(key: string): string {
    return key.replace(/([A-Z])/g, '_$1').toUpperCase();
}

/**
 * Guard for the client get() / getSync() entry points: throw a clear error
 * if a caller passes `undefined` / `null`. Most common cause: reading
 * `PublicConfigKeys.<X>` / `FeatureFlagKeys.<X>` for a key that wasn't
 * declared in the schema — the index lookup returns `undefined` and
 * without this guard `toUpperSnakeCase(undefined)` crashes with the
 * cryptic "Cannot read properties of undefined (reading 'replace')".
 * Mirrors `assertKeyDefined` in `@/server/internal` (SMOODEV-841).
 */
function assertClientKeyDefined(key: unknown, tier: 'public' | 'featureFlag'): asserts key is string {
    if (typeof key === 'string' && key.length > 0) return;
    const tierEnum = tier === 'public' ? 'PublicConfigKeys' : 'FeatureFlagKeys';
    throw new Error(
        `@smooai/config (client): ${tier}Config.get() called with ${key === undefined ? 'undefined' : key === null ? 'null' : `non-string (${typeof key})`} key. ` +
            `Most common cause: reading \`${tierEnum}.<X>\` for a key that's not declared in your schema. ` +
            `Add it to .smooai-config/config.ts and run \`smooai-config push\`.`,
    );
}

/**
 * Read the unified bundler-baked env bag.
 *
 * Both `smooConfigPlugin` (Vite) and `withSmooConfig` (Next.js) replace
 * `__SMOO_CLIENT_ENV__` at build time with a literal JSON object
 * containing all baked `*_CONFIG_*` and `*_FEATURE_FLAG_*` values.
 *
 * The SDK's dynamic-key lookups (`obj[computedKey]`) only work when the
 * env bag is a real runtime object. Per-key static substitution of
 * `process.env.X` / `import.meta.env.X` is useless here because the key
 * is only known at call time — so neither bundler rewrites it, and both
 * return `undefined`. A single defined global fixes that for both.
 *
 * Falls back to `{}` if the plugin wasn't installed or the bundler didn't
 * run (e.g. plain tsc/ts-node), preserving the old "return undefined"
 * behaviour in unconfigured environments.
 */
declare const __SMOO_CLIENT_ENV__: Record<string, string> | undefined;

function readClientEnv(): Record<string, string> {
    try {
        // Each bundler's define/DefinePlugin rewrites this to the literal object.
        if (typeof __SMOO_CLIENT_ENV__ !== 'undefined' && __SMOO_CLIENT_ENV__) {
            return __SMOO_CLIENT_ENV__;
        }
    } catch {
        // ReferenceError when neither plugin ran — fall through.
    }
    return {};
}

/**
 * Get a feature flag value from the bundler-baked env bag.
 *
 * Looks up (in order, first hit wins):
 * 1. `NEXT_PUBLIC_FEATURE_FLAG_{KEY}` — populated by `withSmooConfig` (Next.js)
 * 2. `VITE_FEATURE_FLAG_{KEY}` — populated by `smooConfigPlugin` (Vite)
 *
 * The key is converted from camelCase to UPPER_SNAKE_CASE.
 * e.g., `"aboutPage"` → `NEXT_PUBLIC_FEATURE_FLAG_ABOUT_PAGE`
 */
export function getClientFeatureFlag(key: string): boolean {
    assertClientKeyDefined(key, 'featureFlag');
    const envKey = toUpperSnakeCase(key);
    const env = readClientEnv();
    const raw = env[`NEXT_PUBLIC_FEATURE_FLAG_${envKey}`] ?? env[`VITE_FEATURE_FLAG_${envKey}`];
    if (raw === undefined) return false;
    return raw === 'true' || raw === '1';
}

/**
 * Get a public config value from the bundler-baked env bag.
 *
 * Looks up (in order, first hit wins):
 * 1. `NEXT_PUBLIC_CONFIG_{KEY}` — populated by `withSmooConfig` (Next.js)
 * 2. `VITE_CONFIG_{KEY}` — populated by `smooConfigPlugin` (Vite)
 *
 * The key is converted from camelCase to UPPER_SNAKE_CASE.
 * e.g., `"apiBaseUrl"` → `NEXT_PUBLIC_CONFIG_API_BASE_URL`
 */
export function getClientPublicConfig(key: string): string | undefined {
    assertClientKeyDefined(key, 'public');
    const envKey = toUpperSnakeCase(key);
    const env = readClientEnv();
    return env[`NEXT_PUBLIC_CONFIG_${envKey}`] ?? env[`VITE_CONFIG_${envKey}`];
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

/**
 * Create a typed segment-aware feature-flag evaluator from a config's
 * FeatureFlagKeys and a `ConfigClient`. Always hits the server-side
 * evaluator — segment rules (percentage rollout, attribute matching,
 * bucketing) live server-side. Use this when the flag result depends on
 * per-request context.
 *
 * @example
 * ```tsx
 * import { ConfigClient, createFeatureFlagEvaluator } from '@smooai/config/client';
 *
 * const client = new ConfigClient();
 * export const evaluateFeatureFlag = createFeatureFlagEvaluator<typeof FeatureFlagKeys>(client);
 *
 * const { value, source } = await evaluateFeatureFlag('aboutPage', {
 *   userId: user.id,
 *   tenantId: tenant.id,
 *   plan: tenant.plan,
 * });
 * ```
 */
export function createFeatureFlagEvaluator<T extends Record<string, string>>(
    client: ConfigClient,
): (key: T[keyof T], context?: Record<string, unknown>, environment?: string) => Promise<EvaluateFeatureFlagResponse> {
    return (key, context, environment) => client.evaluateFeatureFlag(key as string, context ?? {}, environment);
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
        assertClientKeyDefined(key, 'public');
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
        assertClientKeyDefined(key, 'featureFlag');
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
                assertClientKeyDefined(key, 'public');
                const v = getClientPublicConfig(key as string);
                return v as unknown as ConfigType[K] | undefined;
            },
        },
        featureFlag: {
            get: getFlag,
            getSync: <K extends FlagKey>(key: K): ConfigType[K] | undefined => {
                assertClientKeyDefined(key, 'featureFlag');
                const v = getClientFeatureFlag(key as string);
                return v as unknown as ConfigType[K] | undefined;
            },
        },
    };
}
