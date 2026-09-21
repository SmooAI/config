/* eslint-disable @typescript-eslint/no-explicit-any -- serialized schema carries unknown shapes across tiers */
/**
 * Async-only core for `buildConfig`. Lives behind `src/server/index.ts`
 * (which adds synckit-wrapped sync variants on top) and `src/server/sync-worker.ts`
 * (which runs this file inside a synckit worker so the sync path reuses
 * the exact same priority chain).
 *
 * Exported separately so synckit workers can import it without pulling
 * `createSyncFn` back into the worker bundle (which would recurse).
 */
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, InferConfigTypes } from '@/config/config';
import { findAndProcessFileConfig } from '@/config/findAndProcessFileConfig';
import { generateZodSchemas, parseConfigKey } from '@/config/parseConfigSchema';
import { ConfigClient, ConfigClientOptions } from '@/platform/client';
import TTLCache from '@isaacs/ttlcache';
import Logger from '@smooai/logger/Logger';

const logger = new Logger({ name: '@smooai/config/server' });

interface DecryptedBlob {
    public: Record<string, unknown>;
    secret: Record<string, unknown>;
    /**
     * Environment the blob was baked against (SMOODEV-1136). Older blobs
     * baked before this field existed are normalized to `'development'` —
     * see the back-compat note in `decryptBlob()`. The reader compares this
     * to the active `SMOOAI_CONFIG_ENV` and skips the blob tier on a
     * mismatch so a dev-baked blob can't silently leak dev secrets into a
     * prod-targeting script.
     */
    bakedEnvironment: string;
}

let decryptedBlobCache: DecryptedBlob | null | undefined;
let fileDefaultsCache: Record<string, unknown> | null | undefined;

/**
 * Has the "blob baked for wrong env, skipping" warning fired this process?
 * Logged once per active-env value rather than per-call so a hot path doesn't
 * spam logs — but if the active env changes mid-process we still want a
 * fresh warning for the new env (test runs flip this between blocks).
 * Format: `${bakedEnvironment}->${activeEnvironment}`.
 */
const warnedBlobEnvMismatch = new Set<string>();

/**
 * Default for `SMOOAI_CONFIG_ENV` when unset. Matches every other resolver
 * in this package (`ConfigClient`, `findAndProcessEnvConfig`, etc.).
 */
const DEFAULT_ENV = 'development';

function activeEnvironment(): string {
    return process.env.SMOOAI_CONFIG_ENV ?? DEFAULT_ENV;
}

const VALUE_CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h for public/secret
const FLAG_CACHE_TTL_MS = 1000 * 30; // 30s for flags (live toggle)

const publicValueCache = new TTLCache<string, unknown>({ ttl: VALUE_CACHE_TTL_MS });
const secretValueCache = new TTLCache<string, unknown>({ ttl: VALUE_CACHE_TTL_MS });
const flagValueCache = new TTLCache<string, unknown>({ ttl: FLAG_CACHE_TTL_MS });

/**
 * Decrypt the AES-256-GCM blob produced by the deploy-time baker.
 *
 * Blob layout: `nonce (12 bytes) || ciphertext || authTag (16 bytes)`.
 * Keyed by `SMOO_CONFIG_KEY` (base64 32-byte AES-256 key) from env.
 * Returns `undefined` when the env vars are missing — lets callers fall
 * through to the next tier on dev machines without a baked blob.
 */
function decryptBlob(): DecryptedBlob | undefined {
    const keyFile = process.env.SMOO_CONFIG_KEY_FILE;
    const keyB64 = process.env.SMOO_CONFIG_KEY;
    if (!keyFile || !keyB64) return undefined;

    const key = Buffer.from(keyB64, 'base64');
    if (key.length !== 32) {
        throw new Error(`SMOO_CONFIG_KEY must decode to 32 bytes (got ${key.length})`);
    }

    const blob = readFileSync(keyFile);
    if (blob.length < 28) {
        throw new Error(`smoo-config blob too short (${blob.length} bytes)`);
    }

    const nonce = blob.subarray(0, 12);
    const authTag = blob.subarray(blob.length - 16);
    const ciphertext = blob.subarray(12, blob.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');

    const parsed = JSON.parse(plaintext);
    // SMOODEV-1136: blobs baked before this field existed default to
    // `'development'`. That's the historical default of every env-resolver
    // in this package, and it matches reality — every legacy blob on a
    // developer laptop was minted by `pnpm install` against the dev API.
    // Treating it as `'development'` means an unmarked blob keeps serving
    // its values for dev reads (active env unset / `=development`) and gets
    // skipped for any prod-targeting read (active env `=production`),
    // which is exactly the desired safety bias.
    const bakedEnvironment = typeof parsed.bakedEnvironment === 'string' && parsed.bakedEnvironment.length > 0 ? parsed.bakedEnvironment : DEFAULT_ENV;
    return {
        public: parsed.public ?? {},
        secret: parsed.secret ?? {},
        bakedEnvironment,
    };
}

function getBlob(): DecryptedBlob {
    if (decryptedBlobCache === undefined) {
        try {
            decryptedBlobCache = decryptBlob() ?? null;
        } catch (err) {
            logger.warn({ err }, 'Failed to decrypt smoo-config blob; falling through');
            decryptedBlobCache = null;
        }
    }
    return decryptedBlobCache ?? { public: {}, secret: {}, bakedEnvironment: DEFAULT_ENV };
}

/**
 * SMOODEV-1136: return the blob only when its baked environment matches the
 * active `SMOOAI_CONFIG_ENV`. On mismatch, log a one-time warning per
 * (baked, active) pair and return `undefined` so the caller falls through
 * to the env/HTTP/file tiers.
 *
 * Why this lives in a wrapper rather than `getBlob`: `getBlob` is also used
 * by `recordSource` diagnostics and tests that don't care about the env
 * check. Putting the check on the read path keeps those uses unaffected.
 */
function getEnvScopedBlob(): DecryptedBlob | undefined {
    const blob = getBlob();
    // Empty blob (no SMOO_CONFIG_KEY{,_FILE}) → nothing to validate. Return
    // it so the existing "blob has no keys, fall through" behavior is
    // preserved without firing a misleading mismatch warning.
    if (Object.keys(blob.public).length === 0 && Object.keys(blob.secret).length === 0) {
        return blob;
    }
    const active = activeEnvironment();
    if (blob.bakedEnvironment === active) return blob;

    const warnKey = `${blob.bakedEnvironment}->${active}`;
    if (!warnedBlobEnvMismatch.has(warnKey)) {
        warnedBlobEnvMismatch.add(warnKey);
        logger.warn(
            { bakedEnvironment: blob.bakedEnvironment, activeEnvironment: active },
            `@smooai/config: skipping baked blob — blob was baked for "${blob.bakedEnvironment}" but SMOOAI_CONFIG_ENV is "${active}". Falling through to env/HTTP/file tiers. ` +
                `If you intended to read the blob's environment, set SMOOAI_CONFIG_ENV=${blob.bakedEnvironment}; otherwise re-bake the blob for "${active}" or unset SMOO_CONFIG_KEY{,_FILE} to disable the blob tier.`,
        );
    }
    return undefined;
}

async function loadFileDefaults<Schema extends ReturnType<typeof defineConfig>>(schema: Schema): Promise<Record<string, unknown>> {
    if (fileDefaultsCache === undefined) {
        try {
            const r = await findAndProcessFileConfig(schema);
            fileDefaultsCache = r.config as Record<string, unknown>;
        } catch (err) {
            logger.warn({ err }, 'No local .smooai-config/ defaults; tier skipped');
            fileDefaultsCache = null;
        }
    }
    return fileDefaultsCache ?? {};
}

/**
 * camelCase → UPPER_SNAKE_CASE for env-var reads. Duplicated from
 * `@/client` so this module can stand alone inside the synckit worker
 * without pulling the browser-bundle entrypoint along for the ride.
 */
function envVarNameFor(key: string): string {
    return key.replace(/([A-Z])/g, '_$1').toUpperCase();
}

/**
 * Guard for the get() / getSync() entry points: throw a clear error if a
 * caller passes `undefined` / `null`. The most common cause is reading
 * `SecretConfigKeys.<X>` (or `PublicConfigKeys.<X>` / `FeatureFlagKeys.<X>`)
 * for a key that wasn't declared in the schema — the index lookup then
 * returns `undefined` and the value flows in here. Without this guard the
 * next line is `key.replace(...)` and you get the cryptic "Cannot read
 * properties of undefined (reading 'replace')" stack from envVarNameFor,
 * which has cost real prod debug time (SMOODEV-841).
 */
export function assertKeyDefined(key: unknown, tier: 'public' | 'secret' | 'featureFlag'): asserts key is string {
    if (typeof key === 'string' && key.length > 0) return;
    const tierEnum = tier === 'public' ? 'PublicConfigKeys' : tier === 'secret' ? 'SecretConfigKeys' : 'FeatureFlagKeys';
    throw new Error(
        `@smooai/config: ${tier}Config.get() called with ${key === undefined ? 'undefined' : key === null ? 'null' : `non-string (${typeof key})`} key. ` +
            `Most common cause: reading \`${tierEnum}.<X>\` for a key that's not declared in your schema. ` +
            `Add it to .smooai-config/config.ts and run \`smooai-config push\`.`,
    );
}

function readFromEnv<Schema extends ReturnType<typeof defineConfig>>(schema: Schema, key: string): unknown {
    const raw = process.env[envVarNameFor(key)];
    if (raw === undefined) return undefined;
    try {
        const { allConfigZodSchema } = generateZodSchemas(schema);
        return parseConfigKey(allConfigZodSchema, key, raw);
    } catch {
        return undefined;
    }
}

function isSet(v: unknown): boolean {
    return v !== undefined && v !== null && v !== '';
}

function remember<T>(cache: TTLCache<string, unknown>, key: string, value: T): T {
    cache.set(key, value);
    return value;
}

export interface BuildConfigAsyncOptions {
    /** Override the ConfigClient used for HTTP-tier lookups. */
    httpClient?: ConfigClient;
    /** Options for the ConfigClient when one isn't supplied. Default cacheTtlMs: 30_000. */
    httpClientOptions?: ConfigClientOptions;
}

/**
 * Per-call options for `publicConfig.get` / `secretConfig.get` /
 * `featureFlag.get`. Added in SMOODEV-1136 so callers that always want a
 * live value can bypass the blob/env tiers without resorting to env-var
 * stripping (`-u SMOO_CONFIG_KEY` etc.) — the documented but easy-to-forget
 * workaround.
 */
export interface GetOptions {
    /**
     * Read from exactly one tier and return `undefined` if it doesn't have
     * the key. No fallback to lower tiers. `'http'` is the common case —
     * "always want the live value from the config API regardless of what's
     * baked into the blob".
     *
     * - `'blob'` — encrypted blob written by the deploy-time baker
     * - `'env'`  — `process.env[UPPER_SNAKE_CASE(key)]`
     * - `'http'` — live fetch via ConfigClient
     * - `'file'` — local `.smooai-config/` defaults
     */
    forceTier?: 'blob' | 'env' | 'http' | 'file';
}

export interface ConfigAsyncAccessor<ConfigType, PublicKey extends keyof ConfigType, SecretKey extends keyof ConfigType, FlagKey extends keyof ConfigType> {
    publicConfig: { get: <K extends PublicKey>(key: K, options?: GetOptions) => Promise<ConfigType[K] | undefined> };
    secretConfig: { get: <K extends SecretKey>(key: K, options?: GetOptions) => Promise<ConfigType[K] | undefined> };
    featureFlag: { get: <K extends FlagKey>(key: K, options?: GetOptions) => Promise<ConfigType[K] | undefined> };
    /** Force a re-read of every tier on the next access. */
    invalidateCaches: () => void;
    /** Diagnostic — which tier served this key in the last successful read. */
    getSource: (key: string) => 'blob' | 'env' | 'http' | 'file' | undefined;
    /**
     * Record a source for a key without performing a read. The sync wrapper
     * in `/server/index.ts` uses this to copy sources reported by the
     * synckit worker back into the parent thread's diagnostic map — each
     * worker has its own module scope, so without this the parent's
     * `getSource` never sees sync reads.
     */
    recordSource: (key: string, source: 'blob' | 'env' | 'http' | 'file' | undefined) => void;
}

const lastSource = new Map<string, 'blob' | 'env' | 'http' | 'file'>();

export function buildConfigAsync<Schema extends ReturnType<typeof defineConfig>>(schema: Schema, options?: BuildConfigAsyncOptions) {
    type ConfigType = InferConfigTypes<Schema>['ConfigType'];
    type PublicKey = Extract<InferConfigTypes<Schema>['PublicConfigKeys'][keyof InferConfigTypes<Schema>['PublicConfigKeys']], keyof ConfigType>;
    type SecretKey = Extract<InferConfigTypes<Schema>['SecretConfigKeys'][keyof InferConfigTypes<Schema>['SecretConfigKeys']], keyof ConfigType>;
    type FlagKey = Extract<InferConfigTypes<Schema>['FeatureFlagKeys'][keyof InferConfigTypes<Schema>['FeatureFlagKeys']], keyof ConfigType>;

    // Defer ConfigClient construction to first HTTP-tier access. If
    // construction throws (e.g. SMOOAI_CONFIG_API_URL unset in dev), we
    // flip `httpClientUnavailable` and skip the HTTP tier for the lifetime
    // of this accessor — the other tiers still work.
    let httpClient: ConfigClient | undefined = options?.httpClient;
    let httpClientUnavailable = false;
    function getHttpClient(): ConfigClient | undefined {
        if (httpClient) return httpClient;
        if (httpClientUnavailable) return undefined;
        try {
            httpClient = new ConfigClient({ cacheTtlMs: 30_000, ...(options?.httpClientOptions ?? {}) });
            return httpClient;
        } catch {
            httpClientUnavailable = true;
            return undefined;
        }
    }

    /**
     * SMOODEV-1136: per-tier readers extracted from the bodies of
     * getPublic/getSecret/getFlag so the new `forceTier` option can route
     * to a single tier without duplicating the read+parse logic. Each
     * returns `undefined` when the tier doesn't have the key OR when the
     * tier is unavailable (blob env-mismatch, HTTP threw, etc.) — the
     * caller decides whether to fall through.
     *
     * `readBlobTier` honors the dev-baked-blob env scoping; raw blob reads
     * that ignore the scoping aren't exposed because every path that wants
     * a blob value also wants the safety check.
     */
    function readBlobTier(section: 'public' | 'secret', keyStr: string): unknown {
        const blob = getEnvScopedBlob();
        if (!blob) return undefined;
        return blob[section][keyStr];
    }

    async function readHttpTier(keyStr: string): Promise<unknown> {
        try {
            const hc = getHttpClient();
            return hc ? await hc.getValue(keyStr) : undefined;
        } catch {
            return undefined;
        }
    }

    async function readFileTier(keyStr: string): Promise<unknown> {
        return (await loadFileDefaults(schema))[keyStr];
    }

    async function readTier(tier: 'blob' | 'env' | 'http' | 'file', section: 'public' | 'secret' | 'flag', keyStr: string): Promise<unknown> {
        switch (tier) {
            case 'blob':
                // Flags never live in the blob (see priority chain), so a
                // forced blob read for a flag is always undefined — by design.
                return section === 'flag' ? undefined : readBlobTier(section, keyStr);
            case 'env':
                return readFromEnv(schema, keyStr);
            case 'http':
                return readHttpTier(keyStr);
            case 'file':
                return readFileTier(keyStr);
        }
    }

    async function getPublic<K extends PublicKey>(key: K, options?: GetOptions): Promise<ConfigType[K] | undefined> {
        assertKeyDefined(key, 'public');
        const keyStr = key as unknown as string;

        if (options?.forceTier) {
            // forceTier bypasses the value cache too — callers asking for a
            // specific tier want a live read, not a stale memoized hit from
            // a different tier earlier in the process.
            const v = await readTier(options.forceTier, 'public', keyStr);
            if (isSet(v)) {
                lastSource.set(keyStr, options.forceTier);
                return v as ConfigType[K];
            }
            return undefined;
        }

        const cached = publicValueCache.get(keyStr);
        if (cached !== undefined) return cached as ConfigType[K];

        const fromBlob = readBlobTier('public', keyStr);
        if (isSet(fromBlob)) {
            lastSource.set(keyStr, 'blob');
            return remember(publicValueCache, keyStr, fromBlob) as ConfigType[K];
        }

        const fromEnv = readFromEnv(schema, keyStr);
        if (isSet(fromEnv)) {
            lastSource.set(keyStr, 'env');
            return remember(publicValueCache, keyStr, fromEnv) as ConfigType[K];
        }

        const fromHttp = await readHttpTier(keyStr);
        if (isSet(fromHttp)) {
            lastSource.set(keyStr, 'http');
            return remember(publicValueCache, keyStr, fromHttp) as ConfigType[K];
        }

        const fromFile = await readFileTier(keyStr);
        if (isSet(fromFile)) {
            lastSource.set(keyStr, 'file');
            return remember(publicValueCache, keyStr, fromFile) as ConfigType[K];
        }

        return undefined;
    }

    async function getSecret<K extends SecretKey>(key: K, options?: GetOptions): Promise<ConfigType[K] | undefined> {
        assertKeyDefined(key, 'secret');
        const keyStr = key as unknown as string;

        if (options?.forceTier) {
            const v = await readTier(options.forceTier, 'secret', keyStr);
            if (isSet(v)) {
                lastSource.set(keyStr, options.forceTier);
                return v as ConfigType[K];
            }
            return undefined;
        }

        const cached = secretValueCache.get(keyStr);
        if (cached !== undefined) return cached as ConfigType[K];

        const fromBlob = readBlobTier('secret', keyStr);
        if (isSet(fromBlob)) {
            lastSource.set(keyStr, 'blob');
            return remember(secretValueCache, keyStr, fromBlob) as ConfigType[K];
        }

        const fromEnv = readFromEnv(schema, keyStr);
        if (isSet(fromEnv)) {
            lastSource.set(keyStr, 'env');
            return remember(secretValueCache, keyStr, fromEnv) as ConfigType[K];
        }

        const fromHttp = await readHttpTier(keyStr);
        if (isSet(fromHttp)) {
            lastSource.set(keyStr, 'http');
            return remember(secretValueCache, keyStr, fromHttp) as ConfigType[K];
        }

        const fromFile = await readFileTier(keyStr);
        if (isSet(fromFile)) {
            lastSource.set(keyStr, 'file');
            return remember(secretValueCache, keyStr, fromFile) as ConfigType[K];
        }

        return undefined;
    }

    async function getFlag<K extends FlagKey>(key: K, options?: GetOptions): Promise<ConfigType[K] | undefined> {
        assertKeyDefined(key, 'featureFlag');
        const keyStr = key as unknown as string;

        if (options?.forceTier) {
            const v = await readTier(options.forceTier, 'flag', keyStr);
            if (isSet(v)) {
                lastSource.set(keyStr, options.forceTier);
                return v as ConfigType[K];
            }
            return undefined;
        }

        const cached = flagValueCache.get(keyStr);
        if (cached !== undefined) return cached as ConfigType[K];

        // Flags: HTTP first (live toggle), then env, then file. Blob skipped
        // on purpose — flags are designed to flip without a redeploy.
        const fromHttp = await readHttpTier(keyStr);
        if (isSet(fromHttp)) {
            lastSource.set(keyStr, 'http');
            return remember(flagValueCache, keyStr, fromHttp) as ConfigType[K];
        }

        const fromEnv = readFromEnv(schema, keyStr);
        if (isSet(fromEnv)) {
            lastSource.set(keyStr, 'env');
            return remember(flagValueCache, keyStr, fromEnv) as ConfigType[K];
        }

        const fromFile = await readFileTier(keyStr);
        if (isSet(fromFile)) {
            lastSource.set(keyStr, 'file');
            return remember(flagValueCache, keyStr, fromFile) as ConfigType[K];
        }

        return undefined;
    }

    function invalidateCaches() {
        decryptedBlobCache = undefined;
        fileDefaultsCache = undefined;
        publicValueCache.clear();
        secretValueCache.clear();
        flagValueCache.clear();
        httpClient?.invalidateCache();
        lastSource.clear();
    }

    return {
        publicConfig: { get: getPublic },
        secretConfig: { get: getSecret },
        featureFlag: { get: getFlag },
        invalidateCaches,
        getSource: (key: string) => lastSource.get(key),
        recordSource: (key: string, source) => {
            if (source) lastSource.set(key, source);
        },
    } satisfies ConfigAsyncAccessor<ConfigType, PublicKey, SecretKey, FlagKey>;
}

/** Test-only hook to drop module-scope caches between runs. */
export function __resetServerCaches() {
    decryptedBlobCache = undefined;
    fileDefaultsCache = undefined;
    publicValueCache.clear();
    secretValueCache.clear();
    flagValueCache.clear();
    lastSource.clear();
    warnedBlobEnvMismatch.clear();
}
