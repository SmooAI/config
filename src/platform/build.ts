import crypto from 'node:crypto';
import { ConfigClient, ConfigClientOptions } from './client';

/**
 * Framework-agnostic deploy-time baker.
 *
 * Fetches `public` + `secret` config values for an environment, encrypts the
 * JSON with AES-256-GCM, and returns the ciphertext blob + base64-encoded key.
 * Deploy glue (SST/Vercel/Cloudflare/anything) writes the blob to disk, ships
 * it in the function bundle, and sets two env vars on the function:
 *
 *   SMOO_CONFIG_KEY_FILE = <absolute path to the blob on disk at runtime>
 *   SMOO_CONFIG_KEY      = <returned keyB64>
 *
 * At cold start, `@smooai/config/server` reads both and decrypts
 * once into an in-memory map. No runtime fetch for public + secret values.
 *
 * **Feature flags are intentionally NOT baked** — they're designed to flip
 * without a redeploy, so they stay live-fetched via `ConfigClient`. Pass a
 * `classify` function (or use `classifyFromSchema`) so the baker knows which
 * keys to drop.
 *
 * Blob layout: `nonce (12 random bytes) || ciphertext || authTag (16 bytes)`.
 * Random nonce means re-baking under the same key is safe — though every
 * `buildBundle` call generates a new key anyway, so that's belt-and-braces.
 */

export interface BuildBundleOptions extends ConfigClientOptions {
    /**
     * Classifier for each key. Return `'public'` or `'secret'` to include in
     * the blob, or `'skip'` to omit (e.g., feature flags, which stay live).
     * Default behavior: if no classifier given, every key lands in `public`.
     * Use `classifyFromSchema(configSchema)` for the typical case.
     */
    classify?: (key: string, value: unknown) => 'public' | 'secret' | 'skip';
}

export interface BuildBundleResult {
    /** Base64-encoded 32-byte AES-256 key. Set as `SMOO_CONFIG_KEY`. */
    keyB64: string;
    /** Encrypted blob: `nonce || ciphertext || authTag`. Write to disk, bundle with function. */
    bundle: Buffer;
    /** Number of keys packed (after `skip` filter). */
    keyCount: number;
    /** Number of keys skipped (e.g., feature flags). */
    skippedCount: number;
}

function defaultClassify(): 'public' {
    return 'public';
}

export async function buildBundle(options: BuildBundleOptions): Promise<BuildBundleResult> {
    const { classify = defaultClassify, ...clientOptions } = options;

    const client = new ConfigClient(clientOptions);
    const all = await client.getAllValues(clientOptions.environment);

    const partitioned = {
        public: {} as Record<string, unknown>,
        secret: {} as Record<string, unknown>,
    };
    let skippedCount = 0;
    for (const [k, v] of Object.entries(all)) {
        const section = classify(k, v);
        if (section === 'skip') {
            skippedCount += 1;
            continue;
        }
        partitioned[section][k] = v;
    }

    const plaintext = Buffer.from(JSON.stringify(partitioned), 'utf8');
    const key = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const bundle = Buffer.concat([nonce, ciphertext, authTag]);

    return {
        keyB64: key.toString('base64'),
        bundle,
        keyCount: Object.keys(partitioned.public).length + Object.keys(partitioned.secret).length,
        skippedCount,
    };
}

/**
 * Classifier factory driven by a `defineConfig` schema. Pass the schema you
 * declared in `.smooai-config/config.ts`; each key is routed by whether it
 * exists in `publicConfigSchema`, `secretConfigSchema`, or `featureFlagSchema`.
 * Feature flags return `'skip'` — they stay live-fetched at runtime.
 */
export function classifyFromSchema(configSchema: {
    publicConfigSchema?: Record<string, unknown>;
    secretConfigSchema?: Record<string, unknown>;
    featureFlagSchema?: Record<string, unknown>;
}): (key: string) => 'public' | 'secret' | 'skip' {
    const publicKeys = new Set(Object.keys(configSchema.publicConfigSchema ?? {}));
    const secretKeys = new Set(Object.keys(configSchema.secretConfigSchema ?? {}));
    const flagKeys = new Set(Object.keys(configSchema.featureFlagSchema ?? {}));
    return (key: string) => {
        if (secretKeys.has(key)) return 'secret';
        if (publicKeys.has(key)) return 'public';
        if (flagKeys.has(key)) return 'skip';
        return 'public';
    };
}
