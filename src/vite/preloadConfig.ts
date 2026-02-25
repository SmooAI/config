import { ConfigClient, type ConfigClientOptions } from '../platform/client';

let preloadPromise: Promise<Record<string, unknown>> | null = null;
let preloadedValues: Record<string, unknown> | null = null;

/**
 * Start fetching all config values as early as possible (before React renders).
 * Call this in your entry file before `createRoot()`:
 *
 * ```ts
 * // main.tsx
 * import { preloadConfig } from '@smooai/config/vite';
 *
 * preloadConfig({ environment: 'production' });
 *
 * // ... later, React tree mounts and hooks read from the already-populated cache
 * ```
 *
 * The returned promise resolves with the fetched config values.
 * Subsequent calls return the same promise (singleton behavior).
 */
export function preloadConfig(options?: ConfigClientOptions): Promise<Record<string, unknown>> {
    if (preloadPromise) return preloadPromise;

    const client = new ConfigClient(options);
    preloadPromise = client.getAllValues(options?.environment).then((values) => {
        preloadedValues = values;
        return values;
    });
    return preloadPromise;
}

/**
 * Get the preloaded config values synchronously.
 * Returns `null` if `preloadConfig()` hasn't completed yet.
 */
export function getPreloadedConfig(): Record<string, unknown> | null {
    return preloadedValues;
}

/**
 * Reset preload state (primarily for testing).
 */
export function resetPreload(): void {
    preloadPromise = null;
    preloadedValues = null;
}
