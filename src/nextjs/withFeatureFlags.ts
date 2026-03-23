/**
 * Next.js config helper that injects feature flags as NEXT_PUBLIC_ environment variables.
 *
 * This allows client components to read feature flags via `getClientFeatureFlag()`
 * from `@smooai/config/feature-flags` without importing any Node.js-dependent code.
 *
 * @example
 * ```ts
 * // next.config.ts
 * import { withFeatureFlags } from '@smooai/config/nextjs/withFeatureFlags';
 * import defaultConfig from './.smooai-config/default';
 * import developmentConfig from './.smooai-config/development';
 *
 * const nextConfig = withFeatureFlags({
 *     default: defaultConfig,
 *     development: developmentConfig,
 * });
 *
 * export default nextConfig;
 * ```
 *
 * This will set environment variables like:
 * - NEXT_PUBLIC_FEATURE_FLAG_ABOUT_PAGE=true (in development)
 * - NEXT_PUBLIC_FEATURE_FLAG_ABOUT_PAGE=false (in production)
 *
 * Then in any client component:
 * ```tsx
 * import { getClientFeatureFlag } from '@smooai/config/feature-flags';
 * const isEnabled = getClientFeatureFlag('aboutPage');
 * ```
 */

type NextConfig = Record<string, unknown>;
type FeatureFlagConfig = Record<string, boolean>;

interface WithFeatureFlagsOptions {
    /** Default feature flag values (used in production). */
    default: FeatureFlagConfig;
    /** Development overrides (merged with default). */
    development?: FeatureFlagConfig;
    /** Additional stage-specific overrides. Key is the stage name. */
    [stage: string]: FeatureFlagConfig | undefined;
}

/**
 * Convert a camelCase key to UPPER_SNAKE_CASE.
 * e.g., "aboutPage" → "ABOUT_PAGE"
 */
function toUpperSnakeCase(key: string): string {
    return key.replace(/([A-Z])/g, '_$1').toUpperCase();
}

/**
 * Wraps a Next.js config to inject feature flags as NEXT_PUBLIC_ environment variables.
 *
 * Reads `NEXT_PUBLIC_SST_STAGE` (or `NODE_ENV`) to determine which config to use.
 * Falls back to development config if stage is not 'production'.
 */
export function withFeatureFlags(flagConfigs: WithFeatureFlagsOptions, nextConfig: NextConfig = {}): NextConfig {
    const stage = process.env.NEXT_PUBLIC_SST_STAGE ?? (process.env.NODE_ENV === 'production' ? 'production' : 'development');

    // Merge default with stage-specific overrides
    const defaultFlags = flagConfigs.default ?? {};
    const stageOverrides = flagConfigs[stage] ?? {};
    const resolvedFlags: FeatureFlagConfig = { ...defaultFlags, ...stageOverrides };

    // Inject as NEXT_PUBLIC_ env vars
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(resolvedFlags)) {
        const envKey = `NEXT_PUBLIC_FEATURE_FLAG_${toUpperSnakeCase(key)}`;
        env[envKey] = String(value);
        // Also set in process.env for SSR
        process.env[envKey] = String(value);
    }

    return {
        ...nextConfig,
        env: {
            ...(nextConfig.env as Record<string, string> | undefined),
            ...env,
        },
    };
}
