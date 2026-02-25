import { ConfigClient, type ConfigClientOptions } from '../platform/client';

export interface GetConfigOptions extends ConfigClientOptions {
    /** Config keys to fetch. If omitted, fetches all values for the environment. */
    keys?: string[];
    /** Additional fetch options passed to the underlying HTTP call (e.g., Next.js `{ next: { revalidate: 60 } }`). */
    fetchOptions?: RequestInit;
}

/**
 * Server-side helper for fetching config values in Next.js Server Components or `getServerSideProps`.
 *
 * ```tsx
 * // app/layout.tsx (Server Component)
 * import { getConfig } from '@smooai/config/nextjs';
 *
 * export default async function RootLayout({ children }) {
 *     const config = await getConfig({
 *         environment: 'production',
 *         fetchOptions: { next: { revalidate: 60 } },
 *     });
 *     return (
 *         <SmooConfigProvider initialValues={config}>
 *             {children}
 *         </SmooConfigProvider>
 *     );
 * }
 * ```
 */
export async function getConfig(options: GetConfigOptions = {}): Promise<Record<string, unknown>> {
    const { keys, fetchOptions, ...clientOptions } = options;
    const client = new ConfigClient(clientOptions);

    if (keys && keys.length > 0) {
        const result: Record<string, unknown> = {};
        await Promise.all(
            keys.map(async (key) => {
                result[key] = await client.getValue(key, clientOptions.environment);
            }),
        );
        return result;
    }

    return client.getAllValues(clientOptions.environment, fetchOptions);
}
