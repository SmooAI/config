/**
 * Universal client-safe config readers.
 *
 * Reads from both `NEXT_PUBLIC_` and `VITE_` prefixed env vars,
 * allowing the same code to work in Next.js and Vite environments.
 *
 * @example
 * ```tsx
 * import { getClientFeatureFlag, getClientPublicConfig } from '@smooai/config/client';
 *
 * if (getClientFeatureFlag('aboutPage')) {
 *     // show the feature
 * }
 *
 * const apiUrl = getClientPublicConfig('apiBaseUrl');
 * ```
 */

/**
 * Convert a camelCase key to UPPER_SNAKE_CASE.
 * e.g., "aboutPage" → "ABOUT_PAGE"
 */
export function toUpperSnakeCase(key: string): string {
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

    // Check Vite env var
    const viteValue = typeof process !== 'undefined' ? process.env?.[`VITE_FEATURE_FLAG_${envKey}`] : undefined;
    if (viteValue !== undefined) {
        return viteValue === 'true' || viteValue === '1';
    }

    // Check Vite import.meta.env fallback (available via globalThis in some setups)
    try {
        const viteEnv = (globalThis as Record<string, unknown>).__VITE_ENV__ as Record<string, string> | undefined;
        const viteEnvValue = viteEnv?.[`VITE_FEATURE_FLAG_${envKey}`];
        if (viteEnvValue !== undefined) {
            return viteEnvValue === 'true' || viteEnvValue === '1';
        }
    } catch {
        // Vite env not available
    }

    return false;
}

/**
 * Get a public config value from build-time environment variables.
 *
 * Checks for:
 * 1. NEXT_PUBLIC_CONFIG_{KEY} (Next.js)
 * 2. VITE_CONFIG_{KEY} (Vite)
 *
 * The key is converted from camelCase to UPPER_SNAKE_CASE.
 * e.g., "apiBaseUrl" checks NEXT_PUBLIC_CONFIG_API_BASE_URL
 *
 * @param key - The camelCase config key
 * @returns The config value as a string, or undefined if not set
 */
export function getClientPublicConfig(key: string): string | undefined {
    const envKey = toUpperSnakeCase(key);

    // Check Next.js env var
    const nextValue = typeof process !== 'undefined' ? process.env?.[`NEXT_PUBLIC_CONFIG_${envKey}`] : undefined;
    if (nextValue !== undefined) {
        return nextValue;
    }

    // Check Vite env var
    const viteValue = typeof process !== 'undefined' ? process.env?.[`VITE_CONFIG_${envKey}`] : undefined;
    if (viteValue !== undefined) {
        return viteValue;
    }

    // Check Vite import.meta.env fallback
    try {
        const viteEnv = (globalThis as Record<string, unknown>).__VITE_ENV__ as Record<string, string> | undefined;
        const viteEnvValue = viteEnv?.[`VITE_CONFIG_${envKey}`];
        if (viteEnvValue !== undefined) {
            return viteEnvValue;
        }
    } catch {
        // Vite env not available
    }

    return undefined;
}

/**
 * Create a typed feature flag checker from a config's FeatureFlagKeys.
 *
 * @example
 * ```tsx
 * import { createFeatureFlagChecker } from '@smooai/config/client';
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
