import { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { PublicConfigKey } from './PublicConfigKey';
import { SecretConfigKey } from './SecretConfigKey';
import { FeatureFlagKey } from './FeatureFlagKey';
import { convertKeyToUpperSnakeCase } from './utils';

/**
 * Symbol used to indicate a string schema type in the configuration.
 * This is used to distinguish between string configurations and structured configurations.
 */
export const StringSchema: unique symbol = Symbol('String');
export type StringSchema = typeof StringSchema;

type ConfigSchema = Record<string, StringSchema | StandardSchemaV1>;

type OutputType<E> = E extends StringSchema ? string : E extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<E> : never;

type OuputTypeWithDeferFunctions<S extends ConfigSchema, E> = E extends StringSchema
    ? string | ((config: SchemaOutput<S>) => string)
    : E extends StandardSchemaV1
      ? StandardSchemaV1.InferOutput<E> | ((config: SchemaOutput<S>) => StandardSchemaV1.InferOutput<E>)
      : never;

type SchemaOutput<T extends ConfigSchema> = {
    [K in keyof T]: OutputType<T[K]>;
};

type SchemaOutputWithDeferFunctions<T extends ConfigSchema> = {
    [K in keyof T]: OuputTypeWithDeferFunctions<T, T[K]>;
};

type SnakeCase<S extends string> = S extends `${infer First}${infer Rest}`
    ? First extends '_' | ' '
        ? // if it's "_" or " ", emit a single "_" and keep going
          `_${SnakeCase<Rest>}`
        : Rest extends Uncapitalize<Rest>
          ? // next char is lowercase/non-letter → just lowercase this char
            `${Lowercase<First>}${SnakeCase<Rest>}`
          : // next char is uppercase → lowercase + "_" + recurse
            `${Lowercase<First>}_${SnakeCase<Rest>}`
    : '';

type UpperSnakeCase<S extends string> =
    S extends Uppercase<S>
        ? S extends `${string} ${string}`
            ? // if it had a space, rerun SnakeCase to turn that into " "
              Uppercase<SnakeCase<S>>
            : S
        : Uppercase<SnakeCase<S>>;

type UnionToUpperSnake<U> = U extends string ? UpperSnakeCase<U> : never;

function generateConfigSchema<T extends ConfigSchema>(configSchema: T) {
    const recordSchema = Object.entries(configSchema).reduce(
        (acc, [key, value]) => {
            if (value === StringSchema) {
                acc[key] = z.string().optional();
            } else {
                acc[key] = z
                    .custom<StandardSchemaV1.InferOutput<typeof value>>()
                    .transform((val) => (val ? value['~standard'].validate(val) : undefined))
                    .optional();
            }
            return acc;
        },
        {} as Record<keyof ConfigSchema, z.ZodTypeAny>,
    );

    const recordSchemaWithDeferFunctions = Object.entries(configSchema).reduce(
        (acc, [key, value]) => {
            if (value === StringSchema) {
                acc[key] = z.union([z.string(), z.function().args(z.custom<SchemaOutput<T>>()).returns(z.string())]).optional();
            } else {
                acc[key] = z
                    .union([
                        z.custom<StandardSchemaV1.InferOutput<typeof value>>().transform((val) => (val ? value['~standard'].validate(val) : undefined)),
                        z.function().args(z.custom<SchemaOutput<T>>()).returns(z.custom<StandardSchemaV1.InferOutput<typeof value>>()),
                    ])
                    .optional();
            }
            return acc;
        },
        {} as Record<keyof ConfigSchema, z.ZodTypeAny>,
    );

    return {
        object: z.custom<SchemaOutput<T>>().transform((val) => (val ? z.object(recordSchema).parse(val) : undefined)),
        objectWithDeferFunctions: z
            .custom<SchemaOutputWithDeferFunctions<T>>()
            .transform((val) => (val ? z.object(recordSchemaWithDeferFunctions).parse(val) : undefined)),
    };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapKeysToUpperSnake<T extends Record<string, any>>(obj: T): { [P in keyof T as UnionToUpperSnake<P & string>]: T[P] } {
    const result = {} as { [P in keyof T as UnionToUpperSnake<P & string>]: T[P] };
    for (const key in obj) {
        const snake = convertKeyToUpperSnakeCase(key);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (result as any)[snake] = obj[key];
    }
    return result;
}

/**
 * Creates a configuration definition with public, secret, and feature flag configuration schemas.
 * This function generates type-safe configuration keys and validation schemas.
 *
 * @template Pub - The type of the public configuration schema
 * @template Sec - The type of the secret configuration schema
 * @template FF - The type of the feature flag configuration schema
 * @param publicConfigSchema - Schema definition for public configuration values
 * @param secretConfigSchema - Schema definition for secret configuration values
 * @param featureFlagSchema - Schema definition for feature flag configuration values
 * @returns An object containing:
 *   - PublicConfigKeys: Object mapping public configuration keys to their snake_case versions
 *   - SecretConfigKeys: Object mapping secret configuration keys to their snake_case versions
 *   - FeatureFlagKeys: Object mapping feature flag keys to their snake_case versions
 *   - parseConfig: Function to parse and validate configuration values
 */
export function defineConfig<Pub extends ConfigSchema, Sec extends ConfigSchema, FF extends ConfigSchema>(
    publicConfigSchema: Pub,
    secretConfigSchema: Sec,
    featureFlagSchema: FF,

) {
    const publicCustomConfigKeys = Object.keys(publicConfigSchema).reduce(
        (acc, key) => {
            acc[convertKeyToUpperSnakeCase(key) as UnionToUpperSnake<keyof Pub | keyof typeof PublicConfigKey>] = key;
            return acc;
        },
        {} as Record<UnionToUpperSnake<keyof Pub | keyof typeof PublicConfigKey>, string>,
    );

    const PublicConfigKeys = mapKeysToUpperSnake(publicCustomConfigKeys);

    const secretCustomConfigKeys = Object.keys(secretConfigSchema).reduce(
        (acc, key) => {
            acc[convertKeyToUpperSnakeCase(key) as UnionToUpperSnake<keyof Sec | keyof typeof SecretConfigKey>] = key;
            return acc;
        },
        {} as Record<UnionToUpperSnake<keyof Sec | keyof typeof SecretConfigKey>, string>,
    );

    const SecretConfigKeys = mapKeysToUpperSnake(secretCustomConfigKeys);

    const featureFlagCustomKeys = Object.keys(featureFlagSchema).reduce(
        (acc, key) => {
            acc[convertKeyToUpperSnakeCase(key) as UnionToUpperSnake<keyof FF | keyof typeof FeatureFlagKey>] = key;
            return acc;
        },
        {} as Record<UnionToUpperSnake<keyof FF | keyof typeof FeatureFlagKey>, string>,
    );

    const FeatureFlagKeys = mapKeysToUpperSnake(featureFlagCustomKeys);

    const { objectWithDeferFunctions: allConfigZodSchemaWithDeferFunctions } = generateConfigSchema({
        ...publicConfigSchema,
        ...secretConfigSchema,
        ...featureFlagSchema,
    });

    const parseConfig = (
        config: StandardSchemaV1.InferInput<typeof allConfigZodSchemaWithDeferFunctions>,
    ): StandardSchemaV1.InferOutput<typeof allConfigZodSchemaWithDeferFunctions> => {
        return allConfigZodSchemaWithDeferFunctions.parse(config);
    };

    return {
        PublicConfigKeys,
        SecretConfigKeys,
        FeatureFlagKeys,
        parseConfig,
    };
}

/**
 * Infers the TypeScript types from a configuration definition.
 * This utility type extracts the public keys, secret keys, feature flag keys, and input/output types
 * from a configuration definition created by defineConfig.
 *
 * @template T - The type of the configuration definition
 * @returns An object containing:
 *   - PublicConfigKeys: Type of public configuration keys
 *   - SecretConfigKeys: Type of secret configuration keys
 *   - FeatureFlagKeys: Type of feature flag keys
 *   - ConfigType: Type of the input configuration
 *   - ConfigTypeOutput: Type of the validated output configuration
 */
export type InferConfigTypes<T> = T extends {
    PublicConfigKeys: infer PK;
    SecretConfigKeys: infer SK;
    FeatureFlagKeys: infer FK;
    parseConfig: (input: infer CI) => infer CO;
}
    ? {
          PublicConfigKeys: PK;
          SecretConfigKeys: SK;
          FeatureFlagKeys: FK;
          ConfigType: Partial<CI>;
          ConfigTypeOutput: Partial<CO>;
      }
    : never;
