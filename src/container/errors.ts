/**
 * Typed errors for `@smooai/config` container/runtime mode.
 *
 * These are the load-bearing part of the SMOODEV-1490 fail-loud contract:
 * a missing required value must surface as a clear, actionable error — never
 * a silent `undefined` that detonates downstream (the SMOODEV-1478 incident:
 * a container got `undefined` for `STRIPE_API_KEY`, `new Stripe(undefined)`
 * threw at module load, the process exited 0 before `listen()`, and the pod
 * CrashLooped with the root cause buried under unrelated log noise).
 *
 * Parity note: the dotnet/go/python/rust SDKs MUST expose errors with the
 * same names and the same carried fields (different idioms, identical data):
 *   - ConfigBootstrapError  -> { missing: string[] }
 *   - ConfigKeyUnresolvedError -> { key, env, triedTiers }
 */

/** One of the resolution tiers consulted during a value read. */
export type ConfigTier = 'blob' | 'env' | 'http' | 'file';

/**
 * Thrown by `initContainerConfig` when the container-required environment
 * (see §1 of the spec) is missing or blank. Carries the exact list of
 * offending env var names so the operator can fix the deployment without
 * guessing. No partial init: if any required var is absent, bootstrap fails
 * whole.
 */
export class ConfigBootstrapError extends Error {
    /** Env var names (e.g. `SMOOAI_CONFIG_CLIENT_ID`) that are missing or blank. */
    readonly missing: string[];

    constructor(missing: string[], options?: ErrorOptions) {
        super(
            `[@smooai/config] container-mode bootstrap failed: missing required env ${missing.join(', ')}. ` +
                `Set ${missing.length === 1 ? 'this variable' : 'these variables'} before calling initContainerConfig() ` +
                `(see docs/Container-Runtime-Mode.md for the Kubernetes/ExternalSecret recipe).`,
            options,
        );
        this.name = 'ConfigBootstrapError';
        this.missing = missing;
    }
}

/**
 * Thrown by a required-key read (`secretConfig.get`/`getSync` and the
 * public/flag analogs) in container mode when the value resolves to absent
 * across every active tier. This is the exact class that closes the
 * silent-`undefined` hole (SMOODEV-1478 / SMOODEV-1135).
 *
 * Optional keys (declared via `initContainerConfig({ optionalKeys })`) do NOT
 * throw this — they return the language's absent value.
 */
export class ConfigKeyUnresolvedError extends Error {
    /** The camelCase config key that could not be resolved. */
    readonly key: string;
    /** The environment the read targeted (e.g. `production`). */
    readonly env: string;
    /** The tiers that were consulted, in order, before giving up. */
    readonly triedTiers: ConfigTier[];

    constructor(args: { key: string; env: string; triedTiers: ConfigTier[] }, options?: ErrorOptions) {
        const { key, env, triedTiers } = args;
        super(
            `[@smooai/config] required config key "${key}" did not resolve in environment "${env}" ` +
                `(container mode; tiers tried: ${triedTiers.join(' → ') || 'none'}). ` +
                `Set a value for this key in the config server for "${env}", or mark it optional via ` +
                `initContainerConfig({ optionalKeys: ['${key}'] }).`,
            options,
        );
        this.name = 'ConfigKeyUnresolvedError';
        this.key = key;
        this.env = env;
        this.triedTiers = triedTiers;
    }
}
