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
export const SecretConfigKey = {} as const;

export type SecretConfigKey = (typeof SecretConfigKey)[keyof typeof SecretConfigKey];
