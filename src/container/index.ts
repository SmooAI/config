/**
 * `@smooai/config/container` — container/runtime mode (SMOODEV-1489 / SMOODEV-1490).
 *
 * The TypeScript **reference** implementation of container mode; the
 * dotnet/go/python/rust SDKs mirror this behavior exactly (identical env
 * contract and error semantics — idioms differ, behavior does not).
 *
 * ## Why
 *
 * `@smooai/config` resolves values through four tiers: blob → env → http →
 * file. The blob tier (an encrypted bundle baked into a Lambda layer / image
 * at deploy time, decrypted with a separately-delivered key) is the blessed
 * path for **Lambda**. It is the *wrong* default for long-lived **containers**
 * (EKS/ECS): when the per-build blob key isn't delivered to the pod,
 * resolution silently falls through to the (absent) file tier and returns
 * `undefined` for a required secret (SMOODEV-1478 outage).
 *
 * Container mode makes the **HTTP tier the blessed, first-class path** for
 * containers, authenticated with an OAuth2 `client_credentials` (M2M) token,
 * **fail-loud** so a missing required value is an immediate, clear error
 * (a typed {@link ConfigKeyUnresolvedError}, never a silent `undefined`).
 *
 * ## Usage
 *
 * ```ts
 * import { initContainerConfig } from '@smooai/config/container';
 * import schema from '../.smooai-config/config';
 *
 * // Validates env, mints a token, does an initial fetch — startup fails
 * // loudly here, not on first read.
 * const config = await initContainerConfig({ schema });
 *
 * // Fail-loud: a required secret that doesn't resolve throws.
 * const stripeKey = await config.secretConfig.get('stripeApiKey');
 *
 * // Readiness probe handler:
 * app.get('/healthz/config', () => {
 *   const h = config.health();
 *   return h.status === 'healthy' ? 200 : 503;
 * });
 * ```
 *
 * ## Env contract (§1 — identical across all five SDKs)
 *
 *   SMOOAI_CONFIG_MODE          `container` forces this mode (see §2 / selectMode).
 *   SMOOAI_CONFIG_API_URL       (required) config API base URL.
 *   SMOOAI_CONFIG_AUTH_URL      OAuth issuer base URL (default https://auth.smoo.ai).
 *   SMOOAI_CONFIG_CLIENT_ID     (required) M2M OAuth client id.
 *   SMOOAI_CONFIG_CLIENT_SECRET (required) M2M OAuth client secret
 *                               (legacy alias SMOOAI_CONFIG_API_KEY accepted).
 *   SMOOAI_CONFIG_ORG_ID        (required) org id whose config to fetch.
 *   SMOOAI_CONFIG_ENV           (required) environment name (e.g. production).
 */
import { defineConfig, InferConfigTypes } from '@/config/config';
import { ConfigClient } from '@/platform/client';
import { TokenProvider } from '@/platform/TokenProvider';
import Logger from '@smooai/logger/Logger';
import { ConfigBootstrapError, ConfigKeyUnresolvedError, ConfigTier } from './errors';

export { ConfigBootstrapError, ConfigKeyUnresolvedError } from './errors';
export type { ConfigTier } from './errors';

const logger = new Logger({ name: '@smooai/config/container' });

/** Default config-value cache TTL (§5). Same 30s default in every SDK. */
export const DEFAULT_CACHE_TTL_MS = 30_000;

/** Default token proactive-refresh window (§5). Matches `TokenProvider`. */
export const DEFAULT_TOKEN_REFRESH_BUFFER_SECONDS = 60;

function readEnv(name: string): string | undefined {
    if (typeof process !== 'undefined' && process.env) return process.env[name];
    return undefined;
}

/** Blank-aware presence check for env vars (a set-but-empty var counts as missing). */
function nonBlank(v: string | undefined): string | undefined {
    if (v === undefined) return undefined;
    const trimmed = v.trim();
    return trimmed.length > 0 ? v : undefined;
}

function isSet(v: unknown): boolean {
    return v !== undefined && v !== null && v !== '';
}

/**
 * Options for {@link initContainerConfig}. Every field mirrors an env var in
 * the §1 contract so tests and embedders can construct a config handle
 * without touching `process.env`. When omitted, the env var is read.
 */
export interface InitContainerConfigOptions<Schema extends ReturnType<typeof defineConfig> = ReturnType<typeof defineConfig>> {
    /**
     * The `defineConfig(...)` schema for this service. Required so the handle
     * can expose typed `secretConfig`/`publicConfig`/`featureFlag` accessors
     * and know which keys exist. (The schema's keys are treated as
     * **required** in container mode by default — see `optionalKeys`.)
     */
    schema: Schema;
    /** Config API base URL. Falls back to `SMOOAI_CONFIG_API_URL`. */
    apiUrl?: string;
    /** OAuth issuer base URL. Falls back to `SMOOAI_CONFIG_AUTH_URL`, then `https://auth.smoo.ai`. */
    authUrl?: string;
    /** M2M OAuth client id. Falls back to `SMOOAI_CONFIG_CLIENT_ID`. */
    clientId?: string;
    /** M2M OAuth client secret. Falls back to `SMOOAI_CONFIG_CLIENT_SECRET`, then legacy `SMOOAI_CONFIG_API_KEY`. */
    clientSecret?: string;
    /** Org id whose config to fetch. Falls back to `SMOOAI_CONFIG_ORG_ID`. */
    orgId?: string;
    /** Environment name (e.g. `production`). Falls back to `SMOOAI_CONFIG_ENV`. */
    environment?: string;
    /**
     * Config value cache TTL in ms. Default {@link DEFAULT_CACHE_TTL_MS} (30s).
     * A background refresh failure serves the last-good value until this TTL
     * hard-expires, at which point `health()` reports `unhealthy` (§5).
     */
    cacheTtlMs?: number;
    /**
     * Seconds before token expiry to proactively refresh. Default
     * {@link DEFAULT_TOKEN_REFRESH_BUFFER_SECONDS} (60s). Forwarded to `TokenProvider`.
     */
    tokenRefreshBufferSeconds?: number;
    /**
     * Keys that are allowed to be absent. A read of any of these returns the
     * absent value instead of throwing {@link ConfigKeyUnresolvedError}.
     * Everything else declared in `schema` is required (container mode's
     * default-required posture — see the design note in the README).
     */
    optionalKeys?: readonly string[];
    /**
     * Test/embedding seam — inject a pre-built `ConfigClient`. When supplied,
     * `apiUrl`/`authUrl`/`clientId`/`clientSecret`/`orgId` env validation is
     * skipped (the client already carries them) but `environment` is still
     * required.
     */
    configClient?: ConfigClient;
    /** Test/embedding seam — inject a pre-built `TokenProvider`. */
    tokenProvider?: TokenProvider;
}

/** Status returned by {@link ContainerConfigHandle.health}. Never throws. */
export type ConfigHealth = { status: 'healthy' } | { status: 'unhealthy'; reason: string };

/**
 * The handle returned by {@link initContainerConfig}. Exposes the same tier
 * accessors as `buildConfig` (async `get` + sync `getSync`) but with §3
 * fail-loud behavior, plus a non-throwing {@link ContainerConfigHandle.health}
 * for k8s readiness/liveness probes.
 */
export interface ContainerConfigHandle<Schema extends ReturnType<typeof defineConfig>> {
    publicConfig: {
        get: <K extends PublicKeyOf<Schema>>(key: K) => Promise<ConfigTypeOf<Schema>[K]>;
        getSync: <K extends PublicKeyOf<Schema>>(key: K) => ConfigTypeOf<Schema>[K];
    };
    secretConfig: {
        get: <K extends SecretKeyOf<Schema>>(key: K) => Promise<ConfigTypeOf<Schema>[K]>;
        getSync: <K extends SecretKeyOf<Schema>>(key: K) => ConfigTypeOf<Schema>[K];
    };
    featureFlag: {
        get: <K extends FlagKeyOf<Schema>>(key: K) => Promise<ConfigTypeOf<Schema>[K]>;
        getSync: <K extends FlagKeyOf<Schema>>(key: K) => ConfigTypeOf<Schema>[K];
    };
    /** Cheap, non-throwing status for readiness/liveness probes (§4). */
    health: () => ConfigHealth;
    /** The underlying `ConfigClient` (escape hatch for advanced callers). */
    readonly client: ConfigClient;
}

type ConfigTypeOf<Schema extends ReturnType<typeof defineConfig>> = InferConfigTypes<Schema>['ConfigType'];
type PublicKeyOf<Schema extends ReturnType<typeof defineConfig>> = Extract<
    InferConfigTypes<Schema>['PublicConfigKeys'][keyof InferConfigTypes<Schema>['PublicConfigKeys']],
    keyof ConfigTypeOf<Schema>
>;
type SecretKeyOf<Schema extends ReturnType<typeof defineConfig>> = Extract<
    InferConfigTypes<Schema>['SecretConfigKeys'][keyof InferConfigTypes<Schema>['SecretConfigKeys']],
    keyof ConfigTypeOf<Schema>
>;
type FlagKeyOf<Schema extends ReturnType<typeof defineConfig>> = Extract<
    InferConfigTypes<Schema>['FeatureFlagKeys'][keyof InferConfigTypes<Schema>['FeatureFlagKeys']],
    keyof ConfigTypeOf<Schema>
>;

/**
 * Resolve and validate the container-mode env contract (§1).
 * Returns the resolved values, or throws {@link ConfigBootstrapError} listing
 * exactly which required vars are missing/blank. No partial result.
 */
interface ResolvedContainerEnv {
    apiUrl: string;
    authUrl: string;
    clientId: string;
    clientSecret: string;
    orgId: string;
    environment: string;
}

function resolveAndValidateEnv(options: InitContainerConfigOptions): ResolvedContainerEnv {
    const apiUrl = nonBlank(options.apiUrl) ?? nonBlank(readEnv('SMOOAI_CONFIG_API_URL'));
    const authUrl = nonBlank(options.authUrl) ?? nonBlank(readEnv('SMOOAI_CONFIG_AUTH_URL')) ?? nonBlank(readEnv('SMOOAI_AUTH_URL')) ?? 'https://auth.smoo.ai';
    const clientId = nonBlank(options.clientId) ?? nonBlank(readEnv('SMOOAI_CONFIG_CLIENT_ID'));
    const clientSecret = nonBlank(options.clientSecret) ?? nonBlank(readEnv('SMOOAI_CONFIG_CLIENT_SECRET')) ?? nonBlank(readEnv('SMOOAI_CONFIG_API_KEY'));
    const orgId = nonBlank(options.orgId) ?? nonBlank(readEnv('SMOOAI_CONFIG_ORG_ID'));
    const environment = nonBlank(options.environment) ?? nonBlank(readEnv('SMOOAI_CONFIG_ENV'));

    // When a ConfigClient is injected it already carries apiUrl/auth/clientId/
    // /secret/orgId — only the environment is still container-required.
    const clientInjected = options.configClient !== undefined;

    const missing: string[] = [];
    if (!clientInjected) {
        if (!apiUrl) missing.push('SMOOAI_CONFIG_API_URL');
        if (!clientId) missing.push('SMOOAI_CONFIG_CLIENT_ID');
        if (!clientSecret) missing.push('SMOOAI_CONFIG_CLIENT_SECRET');
        if (!orgId) missing.push('SMOOAI_CONFIG_ORG_ID');
    }
    if (!environment) missing.push('SMOOAI_CONFIG_ENV');

    if (missing.length > 0) {
        throw new ConfigBootstrapError(missing);
    }

    return {
        apiUrl: apiUrl ?? '',
        authUrl,
        clientId: clientId ?? '',
        clientSecret: clientSecret ?? '',
        orgId: orgId ?? '',
        environment: environment!,
    };
}

/**
 * Explicit container-mode bootstrap (§4). Validates the §1 env, constructs
 * the M2M `TokenProvider` + `ConfigClient`, and performs an **initial token
 * mint + config fetch** so auth/network failures surface at startup, not on
 * first read. Returns a {@link ContainerConfigHandle} whose accessors are
 * fail-loud (§3).
 *
 * @throws {ConfigBootstrapError} when container-required env is missing/blank.
 * @throws on auth/network failure during the initial token mint or fetch.
 */
export async function initContainerConfig<Schema extends ReturnType<typeof defineConfig>>(
    options: InitContainerConfigOptions<Schema>,
): Promise<ContainerConfigHandle<Schema>> {
    if (!options || !options.schema) {
        throw new ConfigBootstrapError(['schema']);
    }
    const env = resolveAndValidateEnv(options);
    const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    const refreshBufferSeconds = options.tokenRefreshBufferSeconds ?? DEFAULT_TOKEN_REFRESH_BUFFER_SECONDS;
    const optionalKeys = new Set<string>(options.optionalKeys ?? []);

    // Build the ConfigClient. When the caller injects one (test/embedding
    // seam) it already carries its own TokenProvider, so we don't build a
    // second one (env creds may be empty in that path).
    const client =
        options.configClient ??
        new ConfigClient({
            baseUrl: env.apiUrl,
            orgId: env.orgId,
            environment: env.environment,
            cacheTtlMs,
            tokenProvider:
                options.tokenProvider ??
                new TokenProvider({
                    authUrl: env.authUrl,
                    clientId: env.clientId,
                    clientSecret: env.clientSecret,
                    refreshWindowSec: refreshBufferSeconds,
                }),
        });

    // Health state (§5): once an initial fetch succeeds we serve last-good on
    // a later background refresh failure until the cache TTL hard-expires.
    let lastFetchOk = false;
    let lastFetchAt = 0;
    let lastError: string | undefined;

    // Initial config fetch — fail loud at startup, not first read. The OAuth
    // token mint happens inside getAllValues (the ConfigClient's TokenProvider
    // exchanges on the first authed request), so an auth failure surfaces here
    // too. A pod that can't reach the config server should CrashLoop visibly,
    // not start degraded.
    try {
        await client.getAllValues(env.environment);
        lastFetchOk = true;
        lastFetchAt = Date.now();
    } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        throw err;
    }

    const isOptional = (key: string): boolean => optionalKeys.has(key);

    /**
     * Async tier read for a single key. Order matches the existing chain's
     * env-over-http precedence: an explicitly-set process env var wins, else
     * the HTTP (config server) value. Blob/file tiers are disabled in
     * container mode (§2).
     */
    async function resolve(key: string): Promise<{ value: unknown; tried: ConfigTier[] }> {
        const tried: ConfigTier[] = [];

        // env tier — explicit process override (matches existing precedence).
        tried.push('env');
        const fromEnv = readEnv(envVarNameFor(key));
        if (isSet(fromEnv)) {
            client.seedCache(key, fromEnv, env.environment);
            return { value: fromEnv, tried };
        }

        // http tier — the blessed container path.
        tried.push('http');
        try {
            const value = await client.getValue(key, env.environment);
            lastFetchOk = true;
            lastFetchAt = Date.now();
            lastError = undefined;
            if (isSet(value)) return { value, tried };
            return { value: undefined, tried };
        } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            // §5: serve last-good from cache until TTL hard-expiry.
            const cached = client.getCachedValue(key, env.environment);
            if (isSet(cached)) {
                logger.warn({ key, err }, 'container config: HTTP refresh failed; serving last-good cached value');
                return { value: cached, tried };
            }
            return { value: undefined, tried };
        }
    }

    function syncResolve(key: string): { value: unknown; tried: ConfigTier[] } {
        const tried: ConfigTier[] = [];
        tried.push('env');
        const fromEnv = readEnv(envVarNameFor(key));
        if (isSet(fromEnv)) return { value: fromEnv, tried };
        tried.push('http');
        const cached = client.getCachedValue(key, env.environment);
        return { value: cached, tried };
    }

    function assertKey(key: unknown, tier: 'public' | 'secret' | 'featureFlag'): asserts key is string {
        if (typeof key === 'string' && key.length > 0) return;
        const tierEnum = tier === 'public' ? 'PublicConfigKeys' : tier === 'secret' ? 'SecretConfigKeys' : 'FeatureFlagKeys';
        throw new Error(
            `@smooai/config (container): ${tier}Config called with ${
                key === undefined ? 'undefined' : key === null ? 'null' : `non-string (${typeof key})`
            } key. Most common cause: reading \`${tierEnum}.<X>\` for a key not declared in your schema.`,
        );
    }

    function makeAsyncGetter<K extends string>(assertTier: 'public' | 'secret' | 'featureFlag') {
        return async (key: K): Promise<unknown> => {
            assertKey(key, assertTier);
            const { value, tried } = await resolve(key);
            if (isSet(value)) return value;
            if (isOptional(key)) return undefined;
            throw new ConfigKeyUnresolvedError({ key, env: env.environment, triedTiers: tried });
        };
    }

    function makeSyncGetter<K extends string>(assertTier: 'public' | 'secret' | 'featureFlag') {
        return (key: K): unknown => {
            assertKey(key, assertTier);
            const { value, tried } = syncResolve(key);
            if (isSet(value)) return value;
            if (isOptional(key)) return undefined;
            throw new ConfigKeyUnresolvedError({ key, env: env.environment, triedTiers: tried });
        };
    }

    // Token validity contributes to health: if we can't mint/refresh, the
    // HTTP tier is dead. We probe cheaply by checking the cached token isn't
    // both absent and unrefreshable — but TokenProvider already refreshes
    // proactively, so the truest signal is the last fetch outcome + TTL.
    function health(): ConfigHealth {
        if (!lastFetchOk) {
            return { status: 'unhealthy', reason: lastError ?? 'initial config fetch has not succeeded' };
        }
        const age = Date.now() - lastFetchAt;
        // Serve healthy while within (cacheTtlMs) of the last good fetch even
        // if a background refresh just failed. Past the hard TTL, a failed
        // refresh flips us unhealthy (§5).
        if (lastError !== undefined && age > cacheTtlMs) {
            return { status: 'unhealthy', reason: `last config refresh failed and cache TTL (${cacheTtlMs}ms) expired: ${lastError}` };
        }
        return { status: 'healthy' };
    }

    return {
        publicConfig: {
            get: makeAsyncGetter('public') as ContainerConfigHandle<Schema>['publicConfig']['get'],
            getSync: makeSyncGetter('public') as ContainerConfigHandle<Schema>['publicConfig']['getSync'],
        },
        secretConfig: {
            get: makeAsyncGetter('secret') as ContainerConfigHandle<Schema>['secretConfig']['get'],
            getSync: makeSyncGetter('secret') as ContainerConfigHandle<Schema>['secretConfig']['getSync'],
        },
        featureFlag: {
            get: makeAsyncGetter('featureFlag') as ContainerConfigHandle<Schema>['featureFlag']['get'],
            getSync: makeSyncGetter('featureFlag') as ContainerConfigHandle<Schema>['featureFlag']['getSync'],
        },
        health,
        client,
    };
}

/**
 * Standalone health check (§4) for a handle. Exposed both as
 * `handle.health()` and as this free function for call sites that prefer the
 * functional form. Never throws.
 */
export function configHealth<Schema extends ReturnType<typeof defineConfig>>(handle: ContainerConfigHandle<Schema>): ConfigHealth {
    try {
        return handle.health();
    } catch (err) {
        return { status: 'unhealthy', reason: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Mode the SDK should run in, per §2. `'container'` means HTTP-primary
 * fail-loud; `'default'` means the existing blob → env → http → file chain.
 */
export type ConfigMode = 'container' | 'default';

/** Inputs for {@link selectMode}. Defaults read from `process.env`. */
export interface SelectModeInputs {
    /** `SMOOAI_CONFIG_MODE`. */
    mode?: string;
    /** `SMOOAI_CONFIG_CLIENT_ID`. */
    clientId?: string;
    /** `SMOOAI_CONFIG_CLIENT_SECRET` (or legacy `SMOOAI_CONFIG_API_KEY`). */
    clientSecret?: string;
    /** `SMOOAI_CONFIG_API_URL`. */
    apiUrl?: string;
    /** Whether a baked blob source is present (`SMOO_CONFIG_KEY` + `SMOO_CONFIG_KEY_FILE`). */
    blobPresent?: boolean;
    /** Whether a local `.smooai-config/` file source is present. */
    filePresent?: boolean;
}

/**
 * Mode selection (§2). Resolution order:
 *   1. `SMOOAI_CONFIG_MODE=container` → container mode (explicit).
 *   2. else if a blob/file source is present → default (Lambda/local), unchanged.
 *   3. else if CLIENT_ID + CLIENT_SECRET + API_URL all set → container (auto;
 *      logs once that container mode was auto-selected).
 *   4. else → default.
 *
 * Container mode MUST NOT silently degrade to the file tier — that decision is
 * enforced by {@link initContainerConfig}'s bootstrap validation; this only
 * decides which mode to enter.
 */
let autoSelectLogged = false;
export function selectMode(inputs: SelectModeInputs = {}): ConfigMode {
    const mode = nonBlank(inputs.mode) ?? nonBlank(readEnv('SMOOAI_CONFIG_MODE'));
    if (mode?.toLowerCase() === 'container') return 'container';

    const blobPresent = inputs.blobPresent ?? (isSet(readEnv('SMOO_CONFIG_KEY')) && isSet(readEnv('SMOO_CONFIG_KEY_FILE')));
    const filePresent = inputs.filePresent ?? false;
    if (blobPresent || filePresent) return 'default';

    const clientId = nonBlank(inputs.clientId) ?? nonBlank(readEnv('SMOOAI_CONFIG_CLIENT_ID'));
    const clientSecret = nonBlank(inputs.clientSecret) ?? nonBlank(readEnv('SMOOAI_CONFIG_CLIENT_SECRET')) ?? nonBlank(readEnv('SMOOAI_CONFIG_API_KEY'));
    const apiUrl = nonBlank(inputs.apiUrl) ?? nonBlank(readEnv('SMOOAI_CONFIG_API_URL'));

    if (clientId && clientSecret && apiUrl) {
        if (!autoSelectLogged) {
            autoSelectLogged = true;
            logger.info(
                { mode: 'container' },
                '@smooai/config: container mode auto-selected (CLIENT_ID + CLIENT_SECRET + API_URL set, no blob/file source present)',
            );
        }
        return 'container';
    }
    return 'default';
}

/** Test-only: reset the once-per-process auto-select log latch. */
export function __resetSelectModeLogForTests(): void {
    autoSelectLogged = false;
}

/** camelCase → UPPER_SNAKE_CASE for env-var reads (matches server tier). */
function envVarNameFor(key: string): string {
    return key.replace(/([A-Z])/g, '_$1').toUpperCase();
}
