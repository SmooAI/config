/**
 * Extendable enum representing public config keys.
 *
 * This class is used to define the public config keys that are available to the application.
 *
 * An example of public confg keys is configurable values that you don't mind being exposed to the user, like a public API key for accessing a headless CMS.
 *
 * @example
 * ```typescript
 * export class MyPublicConfigKey extends PublicConfigKey {
 *    static readonly MY_PUBLIC_API_KEY = 'MY_PUBLIC_API_KEY';
 * }
 */
export const PublicConfigKey = {
    ENV: 'ENV',
    REGION: 'REGION',
    CLOUD_PROVIDER: 'CLOUD_PROVIDER',
} as const;

export type PublicConfigKey = (typeof PublicConfigKey)[keyof typeof PublicConfigKey];

/**
 * extendPublicConfigKey - Extend the PublicConfigKey enum with additional keys for your use.
 *
 * @param extenstion - The additional keys to add to the PublicConfigKey enum.
 *
 * @example
 * ```typescript
 * const MyPublicConfigKey = extendPublicConfigKey({
 *    MY_PUBLIC_API_KEY: 'MY_PUBLIC_API_KEY',
 * } as const);
 * @returns
 */
export function extendPublicConfigKey<T extends Readonly<Record<string, string>>>(extenstion: T): T & typeof PublicConfigKey {
    return {
        ...PublicConfigKey,
        ...extenstion,
    };
}

/**
 * InferPublicConfigKeyType - Infer the type of the keys from the PublicConfigKey enum.
 *
 * @example
 * ```typescript
 * export type MyPublicConfigKey = InferPublicConfigKeyType<typeof MyPublicConfigKey>;
 * ```
 */
export type InferPublicConfigKeyType<T extends Record<string, string>> = T[keyof T];
