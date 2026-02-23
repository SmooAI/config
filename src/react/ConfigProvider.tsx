'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { ConfigClient, type ConfigClientOptions } from '../platform/client';

const ConfigContext = createContext<ConfigClient | null>(null);

export interface ConfigProviderProps extends ConfigClientOptions {
    children: ReactNode;
}

/**
 * Provides a ConfigClient instance to all descendant components.
 *
 * ```tsx
 * <ConfigProvider baseUrl="https://api.smooai.dev" apiKey="..." orgId="..." environment="production">
 *   <App />
 * </ConfigProvider>
 * ```
 *
 * All props are optional if the corresponding environment variables are set:
 *   SMOOAI_CONFIG_API_URL, SMOOAI_CONFIG_API_KEY, SMOOAI_CONFIG_ORG_ID, SMOOAI_CONFIG_ENV
 */
export function ConfigProvider({ children, ...options }: ConfigProviderProps) {
    const client = useMemo(() => new ConfigClient(options), [options.baseUrl, options.apiKey, options.orgId, options.environment]);

    return <ConfigContext.Provider value={client}>{children}</ConfigContext.Provider>;
}

/**
 * Access the ConfigClient instance from the nearest ConfigProvider.
 * Throws if used outside a ConfigProvider.
 */
export function useConfigClient(): ConfigClient {
    const client = useContext(ConfigContext);
    if (!client) {
        throw new Error('useConfigClient must be used within a <ConfigProvider>');
    }
    return client;
}
