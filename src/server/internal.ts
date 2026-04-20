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
}

let decryptedBlobCache: DecryptedBlob | null | undefined;
let fileDefaultsCache: Record<string, unknown> | null | undefined;

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
    return {
        public: parsed.public ?? {},
        secret: parsed.secret ?? {},
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
    return decryptedBlobCache ?? { public: {}, secret: {} };
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

export interface ConfigAsyncAccessor<ConfigType, PublicKey extends keyof ConfigType, SecretKey extends keyof ConfigType, FlagKey extends keyof ConfigType> {
    publicConfig: { get: <K extends PublicKey>(key: K) => Promise<ConfigType[K] | undefined> };
    secretConfig: { get: <K extends SecretKey>(key: K) => Promise<ConfigType[K] | undefined> };
    featureFlag: { get: <K extends FlagKey>(key: K) => Promise<ConfigType[K] | undefined> };
    /** Force a re-read of every tier on the next access. */
    invalidateCaches: () => void;
    /** Diagnostic — which tier served this key in the last successful read. */
    getSource: (key: string) => 'blob' | 'env' | 'http' | 'file' | undefined;
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

    async function getPublic<K extends PublicKey>(key: K): Promise<ConfigType[K] | undefined> {
        const keyStr = key as unknown as string;
        const cached = publicValueCache.get(keyStr);
        if (cached !== undefined) return cached as ConfigType[K];

        const fromBlob = getBlob().public[keyStr];
        if (isSet(fromBlob)) {
            lastSource.set(keyStr, 'blob');
            return remember(publicValueCache, keyStr, fromBlob) as ConfigType[K];
        }

        const fromEnv = readFromEnv(schema, keyStr);
        if (isSet(fromEnv)) {
            lastSource.set(keyStr, 'env');
            return remember(publicValueCache, keyStr, fromEnv) as ConfigType[K];
        }

        try {
            const hc = getHttpClient();
            const fromHttp = hc ? await hc.getValue(keyStr) : undefined;
            if (isSet(fromHttp)) {
                lastSource.set(keyStr, 'http');
                return remember(publicValueCache, keyStr, fromHttp) as ConfigType[K];
            }
        } catch {
            /* fall through to file */
        }

        const fromFile = (await loadFileDefaults(schema))[keyStr];
        if (isSet(fromFile)) {
            lastSource.set(keyStr, 'file');
            return remember(publicValueCache, keyStr, fromFile) as ConfigType[K];
        }

        return undefined;
    }

    async function getSecret<K extends SecretKey>(key: K): Promise<ConfigType[K] | undefined> {
        const keyStr = key as unknown as string;
        const cached = secretValueCache.get(keyStr);
        if (cached !== undefined) return cached as ConfigType[K];

        const fromBlob = getBlob().secret[keyStr];
        if (isSet(fromBlob)) {
            lastSource.set(keyStr, 'blob');
            return remember(secretValueCache, keyStr, fromBlob) as ConfigType[K];
        }

        const fromEnv = readFromEnv(schema, keyStr);
        if (isSet(fromEnv)) {
            lastSource.set(keyStr, 'env');
            return remember(secretValueCache, keyStr, fromEnv) as ConfigType[K];
        }

        try {
            const hc = getHttpClient();
            const fromHttp = hc ? await hc.getValue(keyStr) : undefined;
            if (isSet(fromHttp)) {
                lastSource.set(keyStr, 'http');
                return remember(secretValueCache, keyStr, fromHttp) as ConfigType[K];
            }
        } catch {
            /* fall through to file */
        }

        const fromFile = (await loadFileDefaults(schema))[keyStr];
        if (isSet(fromFile)) {
            lastSource.set(keyStr, 'file');
            return remember(secretValueCache, keyStr, fromFile) as ConfigType[K];
        }

        return undefined;
    }

    async function getFlag<K extends FlagKey>(key: K): Promise<ConfigType[K] | undefined> {
        const keyStr = key as unknown as string;
        const cached = flagValueCache.get(keyStr);
        if (cached !== undefined) return cached as ConfigType[K];

        // Flags: HTTP first (live toggle), then env, then file. Blob skipped
        // on purpose — flags are designed to flip without a redeploy.
        try {
            const hc = getHttpClient();
            const fromHttp = hc ? await hc.getValue(keyStr) : undefined;
            if (isSet(fromHttp)) {
                lastSource.set(keyStr, 'http');
                return remember(flagValueCache, keyStr, fromHttp) as ConfigType[K];
            }
        } catch {
            /* fall through */
        }

        const fromEnv = readFromEnv(schema, keyStr);
        if (isSet(fromEnv)) {
            lastSource.set(keyStr, 'env');
            return remember(flagValueCache, keyStr, fromEnv) as ConfigType[K];
        }

        const fromFile = (await loadFileDefaults(schema))[keyStr];
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
}
