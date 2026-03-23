/**
 * Vite plugin that injects feature flags and public config as
 * VITE_FEATURE_FLAG_* and VITE_CONFIG_* environment variables.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { smooConfigPlugin } from '@smooai/config/vite/smooConfigPlugin';
 *
 * export default defineConfig({
 *     plugins: [
 *         smooConfigPlugin({
 *             featureFlags: { aboutPage: true, contactPage: false },
 *             publicConfig: { apiBaseUrl: 'http://localhost:3000' },
 *             stage: 'development',
 *         }),
 *     ],
 * });
 * ```
 *
 * Then in client code:
 * ```tsx
 * import { getClientFeatureFlag, getClientPublicConfig } from '@smooai/config/client';
 * const isEnabled = getClientFeatureFlag('aboutPage');
 * const apiUrl = getClientPublicConfig('apiBaseUrl');
 * ```
 */

import type { Plugin } from 'vite';

export interface SmooConfigPluginOptions {
    /** Feature flag values (boolean). */
    featureFlags?: Record<string, boolean>;
    /** Public config values (string, number, or boolean). */
    publicConfig?: Record<string, string | number | boolean>;
    /** Optional stage name — currently informational; config resolution should happen before calling the plugin. */
    stage?: string;
}

/**
 * Convert a camelCase key to UPPER_SNAKE_CASE.
 * e.g., "aboutPage" → "ABOUT_PAGE"
 */
function toUpperSnakeCase(key: string): string {
    return key.replace(/([A-Z])/g, '_$1').toUpperCase();
}

/**
 * Vite plugin that injects feature flags and public config as environment variables.
 *
 * Sets `process.env.VITE_FEATURE_FLAG_*` and `process.env.VITE_CONFIG_*` in the
 * Vite `config` hook so they are available at build time via `import.meta.env`.
 */
export function smooConfigPlugin(options: SmooConfigPluginOptions): Plugin {
    return {
        name: 'smoo-config',
        config() {
            const envVars: Record<string, string> = {};

            // Feature flags → VITE_FEATURE_FLAG_*
            if (options.featureFlags) {
                for (const [key, value] of Object.entries(options.featureFlags)) {
                    const envKey = `VITE_FEATURE_FLAG_${toUpperSnakeCase(key)}`;
                    envVars[envKey] = String(value);
                    process.env[envKey] = String(value);
                }
            }

            // Public config → VITE_CONFIG_*
            if (options.publicConfig) {
                for (const [key, value] of Object.entries(options.publicConfig)) {
                    const envKey = `VITE_CONFIG_${toUpperSnakeCase(key)}`;
                    envVars[envKey] = String(value);
                    process.env[envKey] = String(value);
                }
            }

            // Return define map so Vite replaces these at build time
            const define: Record<string, string> = {};
            for (const [key, value] of Object.entries(envVars)) {
                define[`import.meta.env.${key}`] = JSON.stringify(value);
            }

            return { define };
        },
    };
}
