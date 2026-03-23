/**
 * Next.js config helper that injects feature flags AND public config
 * as NEXT_PUBLIC_ environment variables.
 *
 * This is the unified replacement for `withFeatureFlags`, supporting both
 * feature flags (NEXT_PUBLIC_FEATURE_FLAG_*) and public config values
 * (NEXT_PUBLIC_CONFIG_*).
 *
 * @example
 * ```ts
 * // next.config.ts
 * import { withSmooConfig } from '@smooai/config/nextjs/withSmooConfig';
 *
 * const nextConfig = withSmooConfig({
 *     default: {
 *         featureFlags: { aboutPage: false, contactPage: true },
 *         publicConfig: { apiBaseUrl: 'https://api.smooai.com', maxRetries: 3 },
 *     },
 *     development: {
 *         featureFlags: { aboutPage: true },
 *         publicConfig: { apiBaseUrl: 'http://localhost:3000' },
 *     },
 * });
 *
 * export default nextConfig;
 * ```
 *
 * This will set environment variables like:
 * - NEXT_PUBLIC_FEATURE_FLAG_ABOUT_PAGE=true (in development)
 * - NEXT_PUBLIC_CONFIG_API_BASE_URL=http://localhost:3000 (in development)
 *
 * Then in any client component:
 * ```tsx
 * import { getClientFeatureFlag, getClientPublicConfig } from '@smooai/config/client';
 * const isEnabled = getClientFeatureFlag('aboutPage');
 * const apiUrl = getClientPublicConfig('apiBaseUrl');
 * ```
 */

type NextConfig = Record<string, unknown>;

export interface SmooConfigValues {
    /** Feature flag values (boolean). */
    featureFlags?: Record<string, boolean>;
    /** Public config values (string, number, or boolean). */
    publicConfig?: Record<string, string | number | boolean>;
}

export interface WithSmooConfigOptions {
    /** Default config values (used in production). */
    default: SmooConfigValues;
    /** Development overrides (merged with default). */
    development?: SmooConfigValues;
    /** Additional stage-specific overrides. Key is the stage name. */
    [stage: string]: SmooConfigValues | undefined;
}

/**
 * Convert a camelCase key to UPPER_SNAKE_CASE.
 * e.g., "aboutPage" → "ABOUT_PAGE"
 */
function toUpperSnakeCase(key: string): string {
    return key.replace(/([A-Z])/g, '_$1').toUpperCase();
}

/**
 * Wraps a Next.js config to inject feature flags and public config
 * as NEXT_PUBLIC_ environment variables.
 *
 * Reads `NEXT_PUBLIC_SST_STAGE` (or `NODE_ENV`) to determine which config to use.
 * Falls back to development config if stage is not 'production'.
 */
export function withSmooConfig(options: WithSmooConfigOptions, nextConfig: NextConfig = {}): NextConfig {
    const stage = process.env.NEXT_PUBLIC_SST_STAGE ?? (process.env.NODE_ENV === 'production' ? 'production' : 'development');

    // Merge default with stage-specific overrides
    const defaultValues = options.default ?? {};
    const stageOverrides = options[stage] ?? {};

    const resolvedFlags: Record<string, boolean> = {
        ...defaultValues.featureFlags,
        ...stageOverrides.featureFlags,
    };

    const resolvedConfig: Record<string, string | number | boolean> = {
        ...defaultValues.publicConfig,
        ...stageOverrides.publicConfig,
    };

    // Inject as NEXT_PUBLIC_ env vars
    const env: Record<string, string> = {};

    // Feature flags → NEXT_PUBLIC_FEATURE_FLAG_*
    for (const [key, value] of Object.entries(resolvedFlags)) {
        const envKey = `NEXT_PUBLIC_FEATURE_FLAG_${toUpperSnakeCase(key)}`;
        env[envKey] = String(value);
        // Also set in process.env for SSR
        process.env[envKey] = String(value);
    }

    // Public config → NEXT_PUBLIC_CONFIG_*
    for (const [key, value] of Object.entries(resolvedConfig)) {
        const envKey = `NEXT_PUBLIC_CONFIG_${toUpperSnakeCase(key)}`;
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
