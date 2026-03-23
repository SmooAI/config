/**
 * Client-safe feature flag utilities.
 *
 * These functions read feature flags from build-time environment variables
 * (NEXT_PUBLIC_FEATURE_FLAG_* or VITE_FEATURE_FLAG_*) and can be used
 * in both server and client components.
 *
 * @example
 * ```tsx
 * // In your .smooai-config/config.ts:
 * const config = defineConfig({
 *     featureFlagSchema: {
 *         aboutPage: BooleanSchema,
 *         contactPage: BooleanSchema,
 *     },
 * });
 *
 * // In your next.config.js, inject flags as env vars:
 * // NEXT_PUBLIC_FEATURE_FLAG_ABOUT_PAGE=true
 *
 * // In any component (server or client):
 * import { getClientFeatureFlag } from '@smooai/config/feature-flags';
 *
 * if (getClientFeatureFlag('aboutPage')) {
 *     // show the feature
 * }
 * ```
 */

/**
 * Convert a camelCase feature flag key to UPPER_SNAKE_CASE.
 * e.g., "aboutPage" → "ABOUT_PAGE"
 */
function toUpperSnakeCase(key: string): string {
    return key.replace(/([A-Z])/g, '_$1').toUpperCase();
}

/**
 * Get a feature flag value from build-time environment variables.
 *
 * Checks for:
 * 1. NEXT_PUBLIC_FEATURE_FLAG_{KEY} (Next.js)
 * 2. VITE_FEATURE_FLAG_{KEY} (Vite)
 *
 * The key is converted from camelCase to UPPER_SNAKE_CASE.
 * e.g., "aboutPage" checks NEXT_PUBLIC_FEATURE_FLAG_ABOUT_PAGE
 *
 * @param key - The camelCase feature flag key
 * @returns true if the flag is explicitly set to "true", false otherwise
 */
export function getClientFeatureFlag(key: string): boolean {
    const envKey = toUpperSnakeCase(key);

    // Check Next.js env var
    const nextValue = typeof process !== 'undefined' ? process.env?.[`NEXT_PUBLIC_FEATURE_FLAG_${envKey}`] : undefined;
    if (nextValue !== undefined) {
        return nextValue === 'true' || nextValue === '1';
    }

    // Check Vite env var (available via import.meta.env in Vite)
    // At build time, Vite replaces import.meta.env.VITE_* with literal values
    // We use a dynamic approach for runtime compatibility
    try {
        const viteEnv = (globalThis as Record<string, unknown>).__VITE_ENV__ as Record<string, string> | undefined;
        const viteValue = viteEnv?.[`VITE_FEATURE_FLAG_${envKey}`];
        if (viteValue !== undefined) {
            return viteValue === 'true' || viteValue === '1';
        }
    } catch {
        // Vite env not available
    }

    return false;
}

/**
 * Create a typed feature flag checker from a config's FeatureFlagKeys.
 *
 * @example
 * ```tsx
 * import config, { FeatureFlagKeys } from '../.smooai-config/config';
 * import { createFeatureFlagChecker } from '@smooai/config/feature-flags';
 *
 * export const getFeatureFlag = createFeatureFlagChecker<typeof FeatureFlagKeys>();
 *
 * // Usage:
 * getFeatureFlag('aboutPage') // typed to valid keys
 * ```
 */
export function createFeatureFlagChecker<T extends Record<string, string>>(): (key: T[keyof T]) => boolean {
    return (key: T[keyof T]) => getClientFeatureFlag(key as string);
}
