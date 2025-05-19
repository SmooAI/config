/* eslint-disable @typescript-eslint/no-explicit-any -- ok */
import { StandardSchemaV1 } from '@standard-schema/spec';
import { Schema, z } from 'zod';
import { PublicConfigKey } from './PublicConfigKey';
import { SecretConfigKey } from './SecretConfigKey';
import { FeatureFlagKey } from './FeatureFlagKey';
import { convertKeyToUpperSnakeCase } from './utils';
import { fromError } from 'zod-validation-error';

/**
 * Symbol used to indicate a string schema type in the configuration.
 * This is used to distinguish between string configurations and structured configurations.
 */
export const StringSchema: unique symbol = Symbol('String');
export type StringSchema = typeof StringSchema;

export const BooleanSchema: unique symbol = Symbol('Boolean');
export type BooleanSchema = typeof BooleanSchema;

export const NumberSchema: unique symbol = Symbol('Number');
export type NumberSchema = typeof NumberSchema;

type ConfigSchema<K extends string | number | symbol = string> = Record<K, StringSchema | StandardSchemaV1 | BooleanSchema | NumberSchema>;

type OutputType<E> = E extends StringSchema ? string : E extends BooleanSchema ? boolean : E extends NumberSchema ? number : E extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<E> : never;

type InputType<E> = E extends StringSchema ? string : E extends BooleanSchema ? boolean : E extends NumberSchema ? number : E extends StandardSchemaV1 ? StandardSchemaV1.InferInput<E> : never;

type OuputTypeWithDeferFunctions<S extends ConfigSchema, E> = E extends StringSchema
    ? string | ((config: SchemaOutput<S>) => string)
    : E extends BooleanSchema
      ? boolean | ((config: SchemaOutput<S>) => boolean)
      : E extends NumberSchema
        ? number | ((config: SchemaOutput<S>) => number)
        : E extends StandardSchemaV1
          ? StandardSchemaV1.InferOutput<E> | ((config: SchemaOutput<S>) => StandardSchemaV1.InferOutput<E>)
      : never;

type InputTypeWithDeferFunctions<S extends ConfigSchema, E> = E extends StringSchema
    ? string | ((config: SchemaInput<S>) => string)
    : E extends BooleanSchema
      ? boolean | ((config: SchemaInput<S>) => boolean)
      : E extends NumberSchema
        ? number | ((config: SchemaInput<S>) => number)
        : E extends StandardSchemaV1
          ? StandardSchemaV1.InferInput<E> | ((config: SchemaInput<S>) => StandardSchemaV1.InferInput<E>)
      : never;

type SchemaOutput<T extends ConfigSchema> = {
    [K in keyof T]?: OutputType<T[K]>;
};

type SchemaInput<T extends ConfigSchema> = {
    [K in keyof T]?: InputType<T[K]>;
};

type SchemaOutputWithDeferFunctions<T extends ConfigSchema> = {
    [K in keyof T]?: OuputTypeWithDeferFunctions<T, T[K]>;
};

type SchemaInputWithDeferFunctions<T extends ConfigSchema> = {
    [K in keyof T]?: InputTypeWithDeferFunctions<T, T[K]>;
};

type ZodOutputType<T extends ConfigSchema> = {
    [K in keyof T]: z.ZodType<OutputType<T[K]>>;
};

type ZodOutputTypeWithDeferFunctions<T extends ConfigSchema> = {
    [K in keyof T]: z.ZodType<OuputTypeWithDeferFunctions<T, T[K]>>;
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
                (acc as any)[key] = z.coerce.string().optional();
            } else if (value === BooleanSchema) {
                (acc as any)[key] = z.coerce.boolean().optional();
            } else if (value === NumberSchema) {
                (acc as any)[key] = z.coerce.number().optional();
            } else {
                (acc as any)[key] = z
                    .custom<StandardSchemaV1.InferInput<typeof value>>()
                    .transform((val) => (val ? value['~standard'].validate(val) : undefined))
                    .optional();
            }
            return acc;
        },
        {} as ZodOutputType<T>,
    );

    const recordSchemaWithDeferFunctions = Object.entries(configSchema).reduce(
        (acc, [key, value]) => {
            if (value === StringSchema) {
                (acc as any)[key] = z.union([z.coerce.string(), z.function().args(z.custom<SchemaInput<T>>()).returns(z.string())]).optional();
            } else if (value === BooleanSchema) {
                (acc as any)[key] = z.union([z.coerce.boolean(), z.function().args(z.custom<SchemaInput<T>>()).returns(z.boolean())]).optional();
            } else if (value === NumberSchema) {
                (acc as any)[key] = z.union([z.coerce.number(), z.function().args(z.custom<SchemaInput<T>>()).returns(z.number())]).optional();
            } else {
                (acc as any)[key] = z
                    .union([
                        z.custom<StandardSchemaV1.InferOutput<typeof value>>().transform((val) => (val ? value['~standard'].validate(val) : undefined)),
                        z.function().args(z.custom<SchemaInput<T>>()).returns(z.custom<StandardSchemaV1.InferOutput<typeof value>>()),
                    ])
                    .optional();
            }
            return acc;
        },
        {} as ZodOutputTypeWithDeferFunctions<T>,
    );

    return {
        object: z.object(recordSchema),
        objectWithDeferFunctions: z.object(recordSchemaWithDeferFunctions)
    };
}

function mapKeysToUpperSnake<
  const T extends Record<string, any>
>(obj: T): {
  [K in keyof T as UnionToUpperSnake<K & string>]: K & string
} {
  const out = {} as {
    [K in keyof T as UnionToUpperSnake<K & string>]: K & string
  };
  for (const key in obj) {
    const snake = convertKeyToUpperSnakeCase(key);
    ;(out as any)[snake] = key;
  }
  return out;
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
export function defineConfig<Pub extends ConfigSchema, Sec extends ConfigSchema, FF extends ConfigSchema>({
    publicConfigSchema,
    secretConfigSchema,
    featureFlagSchema,
}: {
    publicConfigSchema: Pub;
    secretConfigSchema: Sec;
    featureFlagSchema: FF;
}) {
    const standardPublicConfigSchema = {
        [PublicConfigKey.ENV]: StringSchema,
        [PublicConfigKey.CLOUD_PROVIDER]: StringSchema,
        [PublicConfigKey.REGION]: StringSchema,
        [PublicConfigKey.IS_LOCAL]: BooleanSchema,
    }

    const allPublicConfigSchema = {
        ...standardPublicConfigSchema,
        ...publicConfigSchema,
    } as ConfigSchema<keyof Pub | keyof typeof PublicConfigKey>;

    const PublicConfigKeys = mapKeysToUpperSnake(allPublicConfigSchema);

    const SecretConfigKeys = mapKeysToUpperSnake(secretConfigSchema);

    const FeatureFlagKeys = mapKeysToUpperSnake(featureFlagSchema);

    const allConfigSchema: ConfigSchema<keyof Pub | keyof typeof PublicConfigKey | keyof Sec | keyof typeof SecretConfigKey | keyof FF | keyof typeof FeatureFlagKey> = {
        ...allPublicConfigSchema,
        ...secretConfigSchema,
        ...featureFlagSchema,
    };

    const { objectWithDeferFunctions: allConfigZodSchemaWithDeferFunctions } = generateConfigSchema(allConfigSchema);

    const parseConfig = (
        config: SchemaInputWithDeferFunctions<typeof publicConfigSchema & typeof secretConfigSchema & typeof featureFlagSchema>,
    ): SchemaOutputWithDeferFunctions<typeof publicConfigSchema & typeof secretConfigSchema & typeof featureFlagSchema> => {
        try {
            return allConfigZodSchemaWithDeferFunctions.parse(config) as any;
        } catch (error) {
            throw fromError(error);
        }
    };

    const get = <K extends keyof Pub | keyof typeof PublicConfigKey | keyof Sec | keyof typeof SecretConfigKey | keyof FF | keyof typeof FeatureFlagKey>(
        _key: K,
    ): SchemaOutput<typeof publicConfigSchema & typeof secretConfigSchema & typeof featureFlagSchema>[K] => {
        throw new Error('Not implemented');
    }

    const _configType: SchemaOutput<typeof publicConfigSchema & typeof secretConfigSchema & typeof featureFlagSchema> = {} as any;

    return {
        PublicConfigKeys,
        SecretConfigKeys,
        FeatureFlagKeys,
        parseConfig,
        get,
        _configType,
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
    get: (key: infer _K) => infer V;
    _configType: infer CT;
}
    ? {
          PublicConfigKeys: PK;
          SecretConfigKeys: SK;
          FeatureFlagKeys: FK;
          ConfigType: CI;
          ConfigTypeOutput: CO;
          ConfigTypeComputed: CT;
      }
    : never;
