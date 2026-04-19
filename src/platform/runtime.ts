import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, InferConfigTypes } from '@/config/config';
import { ConfigClient, ConfigClientOptions } from './client';

/**
 * Bake-aware runtime helper for @smooai/config.
 *
 * Returns the same shape as the existing `buildConfigObject` server helper
 * (`getPublicConfig` / `getSecretConfig` / `getFeatureFlag`), so consumer
 * code stays identical regardless of where the values actually came from.
 * The library API is uniform; only the hydration source differs.
 *
 * Sources:
 *   - Public + secret values → pre-encrypted blob baked into the deployment
 *     artifact (Lambda bundle / container image / EC2 disk).
 *   - Feature flags           → always live-fetched from the config API
 *     (they're designed to flip without a redeploy — never baked).
 *
 * The baker (`@smooai/config/platform/build`) partitions feature flags out
 * via `classifyFromSchema`, so the blob only contains public + secret.
 *
 * Works anywhere Node.js runs with a filesystem: Lambda, ECS, Fargate, EC2,
 * long-lived services, containers. For runtimes without a filesystem
 * (Workers, Vercel edge), skip this module and use `ConfigClient` directly.
 *
 * Environment variables (set by your deploy pipeline):
 *
 *   SMOO_CONFIG_KEY_FILE  — absolute path to the encrypted blob on disk
 *                            (Lambda:  `/var/task/smoo-config.enc`)
 *                            (ECS/EC2: wherever the image/provisioner puts it)
 *   SMOO_CONFIG_KEY       — base64-encoded 32-byte AES-256 key
 *
 *   SMOOAI_CONFIG_API_URL — for feature-flag lookups (forwarded to ConfigClient)
 *   SMOOAI_CONFIG_API_KEY
 *   SMOOAI_CONFIG_ORG_ID
 *   SMOOAI_CONFIG_ENV
 *
 * Blob layout: `nonce (12 bytes) || ciphertext || authTag (16 bytes)`.
 */

interface DecryptedBlob {
    public: Record<string, unknown>;
    secret: Record<string, unknown>;
}

let decryptedCache: DecryptedBlob | undefined;
let hydratedFlagClient: ConfigClient | undefined;

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
    if (!decryptedCache) {
        decryptedCache = decryptBlob() ?? { public: {}, secret: {} };
    }
    return decryptedCache;
}

export interface BuildConfigRuntimeOptions {
    /** Override the ConfigClient used for feature-flag lookups. */
    flagClient?: ConfigClient;
    /** ConfigClient construction options (when no client is supplied). Default cacheTtlMs: 30_000. */
    flagClientOptions?: ConfigClientOptions;
}

/**
 * Build a runtime config accessor with typed, per-tier getters.
 *
 * Returns the same `{ getPublicConfig, getSecretConfig, getFeatureFlag }`
 * shape as the existing `buildConfigObject` server helper — consumer code
 * is portable between baked + file/env modes.
 *
 * @example
 *   import configSchema from '../.smooai-config/config';
 *   import { buildConfigRuntime } from '@smooai/config/platform/runtime';
 *
 *   const config = buildConfigRuntime(configSchema);
 *
 *   const tavily = await config.getSecretConfig(configSchema.SecretConfigKeys.tavilyApiKey);
 *   const apiUrl = await config.getPublicConfig(configSchema.PublicConfigKeys.apiUrl);
 *   const flag   = await config.getFeatureFlag(configSchema.FeatureFlagKeys.newFlow);
 */
export function buildConfigRuntime<Schema extends ReturnType<typeof defineConfig>>(
    configSchema: Schema,
    options?: BuildConfigRuntimeOptions,
): {
    getPublicConfig: <
        K extends Extract<
            InferConfigTypes<Schema>['PublicConfigKeys'][keyof InferConfigTypes<Schema>['PublicConfigKeys']],
            keyof InferConfigTypes<Schema>['ConfigType']
        >,
    >(
        key: K,
    ) => Promise<InferConfigTypes<Schema>['ConfigType'][K] | undefined>;
    getSecretConfig: <
        K extends Extract<
            InferConfigTypes<Schema>['SecretConfigKeys'][keyof InferConfigTypes<Schema>['SecretConfigKeys']],
            keyof InferConfigTypes<Schema>['ConfigType']
        >,
    >(
        key: K,
    ) => Promise<InferConfigTypes<Schema>['ConfigType'][K] | undefined>;
    getFeatureFlag: <
        K extends Extract<
            InferConfigTypes<Schema>['FeatureFlagKeys'][keyof InferConfigTypes<Schema>['FeatureFlagKeys']],
            keyof InferConfigTypes<Schema>['ConfigType']
        >,
    >(
        key: K,
    ) => Promise<InferConfigTypes<Schema>['ConfigType'][K] | undefined>;
    /** Force a re-read of the baked blob. */
    invalidateBlobCache: () => void;
    /** Clear the feature-flag cache. */
    invalidateFlagCache: () => void;
} {
    void configSchema;

    const getFlagClient = () => {
        if (options?.flagClient) return options.flagClient;
        if (!hydratedFlagClient) {
            hydratedFlagClient = new ConfigClient({
                cacheTtlMs: 30_000,
                ...(options?.flagClientOptions ?? {}),
            });
        }
        return hydratedFlagClient;
    };

    return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic relay into untyped blob
        getPublicConfig: (async (key: any) => getBlob().public[String(key)]) as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic relay into untyped blob
        getSecretConfig: (async (key: any) => getBlob().secret[String(key)]) as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic relay into ConfigClient
        getFeatureFlag: (async (key: any) => (await getFlagClient().getValue(String(key))) as any) as any,
        invalidateBlobCache: () => {
            decryptedCache = undefined;
        },
        invalidateFlagCache: () => {
            hydratedFlagClient?.invalidateCache();
        },
    };
}

/** Internal test helper — reset module-scope caches. */
export function __resetRuntimeCaches(): void {
    decryptedCache = undefined;
    hydratedFlagClient = undefined;
}
