/**
 * SecretConfigKey
 *
 * Extendable enum representing secret config keys.
 *
 * This class is used to define the secret config keys that are available to the application.
 *
 * An example of secret confg keys is configurable values that you do not want to expose to users, like a private API key for accessing customer data.
 *
 * @example
 * ```typescript
 * const MySecretConfigKey = extendSecretConfigKey({
 *     MY_SECRET_API_KEY: 'MY_SECRET_API_KEY',
 * } as const);
 *
 * export type MySecretConfigKey = InferSecretConfigKeyType<typeof MySecretConfigKey>;
 * ```
 */
export const SecretConfigKey = {
    ENV: 'ENV',
} as const;

export type SecretConfigKey = (typeof SecretConfigKey)[keyof typeof SecretConfigKey];

/**
 * extendSecretConfigKey - Extend the SecretConfigKey enum with additional keys for your use.
 *
 * @param extenstion - The additional keys to add to the SecretConfigKey enum.
 *
 * @example
 * ```typescript
 * const MySecretConfigKey = extendSecretConfigKey({
 *    MY_SECRET_API_KEY: 'MY_SECRET_API_KEY',
 * } as const);
 * @returns
 */
export function extendSecretConfigKey<T extends Readonly<Record<string, string>>>(extenstion: T): T & typeof SecretConfigKey {
    return {
        ...SecretConfigKey,
        ...extenstion,
    };
}

/**
 * InferSecretConfigKeyType - Infer the type of the keys from the SecretConfigKey enum.
 *
 * @example
 * ```typescript
 * export type MySecretConfigKey = InferSecretConfigKeyType<typeof MySecretConfigKey>;
 * ```
 */
export type InferSecretConfigKeyType<T extends Record<string, string>> = T[keyof T];
