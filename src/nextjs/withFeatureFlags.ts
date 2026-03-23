/**
 * @deprecated Use `withSmooConfig` from `@smooai/config/nextjs/withSmooConfig` instead.
 *
 * This module is kept for backward compatibility. It wraps `withSmooConfig`
 * to provide the same feature-flag-only API.
 *
 * @example
 * ```ts
 * // Migrate from:
 * import { withFeatureFlags } from '@smooai/config/nextjs/withFeatureFlags';
 * const nextConfig = withFeatureFlags({ default: { aboutPage: false }, development: { aboutPage: true } });
 *
 * // To:
 * import { withSmooConfig } from '@smooai/config/nextjs/withSmooConfig';
 * const nextConfig = withSmooConfig({
 *     default: { featureFlags: { aboutPage: false } },
 *     development: { featureFlags: { aboutPage: true } },
 * });
 * ```
 */

import { withSmooConfig } from './withSmooConfig';
import type { WithSmooConfigOptions } from './withSmooConfig';

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
 * @deprecated Use `withSmooConfig` instead.
 *
 * Wraps a Next.js config to inject feature flags as NEXT_PUBLIC_ environment variables.
 * This is a backward-compatible wrapper around `withSmooConfig`.
 */
export function withFeatureFlags(flagConfigs: WithFeatureFlagsOptions, nextConfig: NextConfig = {}): NextConfig {
    // Convert the flat flag configs into SmooConfigValues format
    const smooOptions: WithSmooConfigOptions = { default: {} };

    for (const [stage, flags] of Object.entries(flagConfigs)) {
        if (flags !== undefined) {
            smooOptions[stage] = { featureFlags: flags };
        }
    }

    return withSmooConfig(smooOptions, nextConfig);
}

// Re-export withSmooConfig types and function for convenience
export { withSmooConfig } from './withSmooConfig';
export type { SmooConfigValues, WithSmooConfigOptions } from './withSmooConfig';
