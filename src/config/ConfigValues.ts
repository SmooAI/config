import { z } from 'zod';
export { z } from 'zod';

function generateConfigKeySchema<Public extends Readonly<Record<string, string>>, Secret extends Readonly<Record<string, string>>>(
    publicConfigKeyObject: Public,
    secretConfigKeyObject: Secret,
) {
    return z.union([z.nativeEnum(publicConfigKeyObject), z.nativeEnum(secretConfigKeyObject)]);
}

function generateDeferFunctionSchema<Public extends Readonly<Record<string, string>>, Secret extends Readonly<Record<string, string>>>(
    publicConfigKeyObject: Public,
    secretConfigKeyObject: Secret,
) {
    return z
        .function()
        .args(z.record(generateConfigKeySchema(publicConfigKeyObject, secretConfigKeyObject)))
        .returns(z.string());
}

function generateDeferFunctionAnySchema<Public extends Readonly<Record<string, string>>, Secret extends Readonly<Record<string, string>>>(
    publicConfigKeyObject: Public,
    secretConfigKeyObject: Secret,
) {
    return z
        .function()
        .args(z.record(generateConfigKeySchema(publicConfigKeyObject, secretConfigKeyObject)))
        .returns(z.union([z.string(), z.any()]));
}

/**
 * Generate a zod schema for the config values object based on the public and secret config keys.
 *
 * @param publicConfigKeyObject - Your extended public config key object (e.g. extendPublicConfigKey({ MY_PUBLIC_API_KEY: 'MY_PUBLIC_API_KEY' } as const))
 * @param secretConfigKeyObject - Your extended secret config key object (e.g. extendSecretConfigKey({ MY_SECRET_API_KEY: 'MY_SECRET_API_KEY' } as const))
 *
 * @example
 * ```typescript
 * const MyPublicConfigKey = extendPublicConfigKey({
 *    MY_PUBLIC_API_KEY: 'MY_PUBLIC_API_KEY',
 *    MY_PUBLIC_API_KEY_2: 'MY_PUBLIC_API_KEY_2',
 *    MY_PUBLIC_API_KEY_3: 'MY_PUBLIC_API_KEY_3',
 *    MY_PUBLIC_STRUCTURED_CONFIG: 'MY_PUBLIC_STRUCTURED_CONFIG',
 * } as const);
 *
 * const MySecretConfigKey = extendSecretConfigKey({
 *    MY_SECRET_API_KEY: 'MY_SECRET_API
 *    MY_SECRET_API_KEY_2: 'MY_SECRET_API_KEY_2',
 *    MY_SECRET_STRUCTURED_CONFIG: 'MY_SECRET_STRUCTURED_CONFIG',
 * } as const);
 *
 * export const MyConfigValues = generateConfigValuesSchema(MyPublicConfigKey, MySecretConfigKey);
 * export type MyConfigValues = ConfigValues<typeof MyPublicConfigKey, typeof MySecretConfigKey>;
 *
 * export const config: MyConfigValues = {
 *    [MyPublicConfigKey.MY_PUBLIC_API_KEY]: 'public',
 *    [MyPublicConfigKey.MY_PUBLIC_API_KEY_2]: (config) => `${config[MyPublicConfigKey.MY_PUBLIC_API_KEY]} - 2`, // Defer assignment based on final config values
 *    [MyPublicConfigKey.MY_PUBLIC_API_KEY_3]: { // Use your own zod schema to enforce the shape of the value
 *       zodSchema: z.string().url(),
 *       value: 'https://example.com',
 *    },
 *    [MyPublicConfigKey.MY_PUBLIC_STRUCTURED_CONFIG]: { // Use your own zod schema to enforce the shape of structured config values
 *        zodSchema: z.object({
 *            key: z.string(),
 *            value: z.string(),
 *        },
 *        value: {
 *            key: 'key',
 *            value: 'value',
 *        }
 *    ),
 *
 *    [MySecretConfigKey.MY_SECRET_API_KEY]: process.env.MY_SECRET_API_KEY,
 *    [MySecretConfigKey.MY_SECRET_API_KEY_2]: (config) => `${config[MySecretConfigKey.MY_SECRET_API_KEY]} - 2`, // Defer assignment based on final config values, including secrets from the server
 *    [MySecretConfigKey.MY_SECRET_STRUCTURED_CONFIG]: { // Use your own zod schema to enforce the shape of the value, even if it's a secret that's stored on the server
 *        zodSchema: z.object({
 *            key: z.string(),
 *            value: z.string(),
 *        }
 *    }
 * };
 * @returns A zod schema for the config values object.
 */
export function generateConfigValuesSchema<Public extends Readonly<Record<string, string>>, Secret extends Readonly<Record<string, string>>>(
    publicConfigKeyObject: Public,
    secretConfigKeyObject: Secret,
) {
    return z.record(
        generateConfigKeySchema(publicConfigKeyObject, secretConfigKeyObject),
        z.union([
            z.string(),
            generateDeferFunctionSchema(publicConfigKeyObject, secretConfigKeyObject),
            z.object({
                zodSchema: z.instanceof(z.ZodType<string>),
                value: z.union([z.string(), generateDeferFunctionAnySchema(publicConfigKeyObject, secretConfigKeyObject)]).optional(),
            }),
        ]),
    );
}

/**
 * Infer the type of the config values object based on the public and secret config keys.
 */
export type ConfigValues<Public extends Readonly<Record<string, string>>, Secret extends Readonly<Record<string, string>>> = z.infer<
    ReturnType<typeof generateConfigValuesSchema<Public, Secret>>
>;
