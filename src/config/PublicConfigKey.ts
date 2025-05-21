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
    IS_LOCAL: 'IS_LOCAL',
    REGION: 'REGION',
    CLOUD_PROVIDER: 'CLOUD_PROVIDER',
} as const;

export type PublicConfigKey = (typeof PublicConfigKey)[keyof typeof PublicConfigKey];
