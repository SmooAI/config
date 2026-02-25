'use client';

import { useEffect, useMemo, type ReactNode } from 'react';
import { ConfigClient, type ConfigClientOptions } from '../platform/client';
import { ConfigContext } from '../react/ConfigProvider';

export interface SmooConfigProviderProps extends ConfigClientOptions {
    /** Initial config values fetched on the server (from `getConfig()`). Pre-seeds the client cache. */
    initialValues?: Record<string, unknown>;
    children: ReactNode;
}

/**
 * Client Component that provides a pre-seeded ConfigClient, eliminating loading
 * flashes on first render when used with server-fetched `initialValues`.
 *
 * ```tsx
 * // layout.tsx (Server Component)
 * const config = await getConfig({ environment: 'production' });
 *
 * // Client boundary
 * <SmooConfigProvider initialValues={config} environment="production" {...clientOptions}>
 *   <App />
 * </SmooConfigProvider>
 * ```
 */
export function SmooConfigProvider({ initialValues, children, ...options }: SmooConfigProviderProps) {
    const client = useMemo(() => {
        const c = new ConfigClient(options);
        if (initialValues) {
            c.seedCacheFromMap(initialValues, options.environment);
        }
        return c;
    }, [options.baseUrl, options.apiKey, options.orgId, options.environment]);

    // Re-seed if initialValues change (e.g., after revalidation)
    useEffect(() => {
        if (initialValues) {
            client.seedCacheFromMap(initialValues, options.environment);
        }
    }, [initialValues, client, options.environment]);

    return <ConfigContext.Provider value={client}>{children}</ConfigContext.Provider>;
}
