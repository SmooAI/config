/* eslint-disable @typescript-eslint/no-explicit-any -- ok */
import { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { PublicConfigKey } from '@/config/PublicConfigKey';
import { SecretConfigKey } from '@/config/SecretConfigKey';
import { FeatureFlagKey } from '@/config/FeatureFlagKey';
import { convertKeyToUpperSnakeCase, SmooaiConfigError, UnionToUpperSnake } from '@/utils';
import { handleSchemaValidationSync } from '@smooai/utils/validation/standardSchema';

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

type OutputType<E> = E extends StringSchema
    ? string
    : E extends BooleanSchema
      ? boolean
      : E extends NumberSchema
        ? number
        : E extends StandardSchemaV1
          ? StandardSchemaV1.InferOutput<E>
          : never;

type InputType<E> = E extends StringSchema
    ? string
    : E extends BooleanSchema
      ? boolean
      : E extends NumberSchema
        ? number
        : E extends StandardSchemaV1
          ? StandardSchemaV1.InferInput<E>
          : never;

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

function handleStandardSchemaValidation(key: string, schema: StandardSchemaV1): (val: any, ctx: z.RefinementCtx) => any {
    return (val, ctx) => {
        if (val) {
            const result = schema['~standard'].validate(val);
            if (result instanceof Promise) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Standard schema validation is async' });
            } else if (result.issues) {
                result.issues.forEach((issue) => {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: issue.message,
                        path: [key, ...(Array.isArray(issue.path) ? issue.path : [issue.path])],
                    });
                });
            } else {
                return result.value;
            }
        }
    };
}

const coerceBooleanSchema = z.union([z.boolean(), z.string(), z.number()]).transform((val) => {
    if (val === null || val === undefined) {
        return val;
    }

    if (typeof val === 'string') {
        return val.toLowerCase() === 'true' || val === '1';
    } else if (typeof val === 'number') {
        return val !== 0;
    }
    return val;
});

function generateConfigSchema<T extends ConfigSchema>(configSchema: T) {
    const recordSchema = Object.entries(configSchema).reduce((acc, [key, value]) => {
        if (value === StringSchema) {
            (acc as any)[key] = z.coerce.string().optional();
        } else if (value === BooleanSchema) {
            (acc as any)[key] = coerceBooleanSchema.optional();
        } else if (value === NumberSchema) {
            (acc as any)[key] = z.coerce.number().optional();
        } else {
            (acc as any)[key] = z.custom<StandardSchemaV1.InferInput<typeof value>>().superRefine(handleStandardSchemaValidation(key, value)).optional();
        }
        return acc;
    }, {} as ZodOutputType<T>);

    const recordSchemaWithDeferFunctions = Object.entries(configSchema).reduce((acc, [key, value]) => {
        if (value === StringSchema) {
            (acc as any)[key] = z.union([z.function().args(z.custom<SchemaInput<T>>()).returns(z.string()), z.coerce.string()]).optional();
        } else if (value === BooleanSchema) {
            (acc as any)[key] = z.union([z.function().args(z.custom<SchemaInput<T>>()).returns(z.boolean()), coerceBooleanSchema]).optional();
        } else if (value === NumberSchema) {
            (acc as any)[key] = z.union([z.function().args(z.custom<SchemaInput<T>>()).returns(z.number()), z.coerce.number()]).optional();
        } else {
            (acc as any)[key] = z
                .union([
                    z.function().args(z.custom<SchemaInput<T>>()).returns(z.custom<StandardSchemaV1.InferOutput<typeof value>>()),
                    z.custom<StandardSchemaV1.InferOutput<typeof value>>().superRefine(handleStandardSchemaValidation(key, value)),
                ])
                .optional();
        }
        return acc;
    }, {} as ZodOutputTypeWithDeferFunctions<T>);

    return {
        object: z.object(recordSchema),
        objectWithDeferFunctions: z.object(recordSchemaWithDeferFunctions),
    };
}

function mapKeysToUpperSnake<const T extends Record<string, any>>(
    obj: T,
): {
    [K in keyof T as UnionToUpperSnake<K & string>]: K & string;
} {
    const out = {} as {
        [K in keyof T as UnionToUpperSnake<K & string>]: K & string;
    };
    for (const key in obj) {
        const snake = convertKeyToUpperSnakeCase(key);
        (out as any)[snake] = key;
    }
    return out;
}

export type ParsedConfigGeneric = Record<
    string,
    | string
    | ((config: Record<string, any>) => string)
    | boolean
    | ((config: Record<string, any>) => boolean)
    | number
    | ((config: Record<string, any>) => number)
    | StandardSchemaV1.InferOutput<StandardSchemaV1>
    | ((config: Record<string, any>) => StandardSchemaV1.InferOutput<StandardSchemaV1>)
>;

/**
 * Creates a configuration definition with public, secret, and feature flag configuration schemas.
 * This function generates type-safe configuration keys and validation schemas.
 *
 * @param publicConfigSchema - Schema definition for public configuration values
 * @param secretConfigSchema - Schema definition for secret configuration values
 * @param featureFlagSchema - Schema definition for feature flag configuration values
 * @returns An object containing:
 *   - PublicConfigKeys: Object mapping public configuration keys to their snake_case versions
 *   - SecretConfigKeys: Object mapping secret configuration keys to their snake_case versions
 *   - FeatureFlagKeys: Object mapping feature flag keys to their snake_case versions
 *   - parseConfig: Function to parse and validate configuration values
 *
 * @example
 * // Basic usage with string and boolean configurations
 * const config = defineConfig({
 *   publicConfigSchema: {
 *     apiUrl: StringSchema,
 *     debugMode: BooleanSchema,
 *     maxRetries: NumberSchema
 *   },
 *   secretConfigSchema: {
 *     apiKey: StringSchema,
 *     jwtSecret: StringSchema
 *   },
 *   featureFlagSchema: {
 *     enableNewUI: BooleanSchema,
 *     betaFeatures: BooleanSchema
 *   }
 * });
 *
 * // Parse configuration values
 * const parsedConfig = config.parseConfig({
 *   apiUrl: 'https://api.example.com',
 *   debugMode: true,
 *   maxRetries: 3,
 *   apiKey: 'secret-key',
 *   jwtSecret: 'jwt-secret',
 *   enableNewUI: true,
 *   betaFeatures: false
 * });
 *
 * @example
 * // Using with StandardSchema for structured configuration
 * const config = defineConfig({
 *   publicConfigSchema: {
 *     database: {
 *       '~standard': z.object({
 *         host: z.string(),
 *         port: z.number(),
 *         credentials: z.object({
 *           username: z.string(),
 *           password: z.string()
 *         })
 *       })
 *     }
 *   }
 * });
 *
 * // Parse structured configuration
 * const parsedConfig = config.parseConfig({
 *   database: {
 *     host: 'localhost',
 *     port: 5432,
 *     credentials: {
 *       username: 'admin',
 *       password: 'secret'
 *     }
 *   }
 * });
 */
export function defineConfig<Pub extends ConfigSchema, Sec extends ConfigSchema, FF extends ConfigSchema>({
    publicConfigSchema,
    secretConfigSchema,
    featureFlagSchema,
}: {
    publicConfigSchema?: Pub | undefined;
    secretConfigSchema?: Sec | undefined;
    featureFlagSchema?: FF | undefined;
}) {
    if (!publicConfigSchema && !secretConfigSchema && !featureFlagSchema) {
        throw new SmooaiConfigError('At least one of publicConfigSchema, secretConfigSchema, or featureFlagSchema must be provided');
    }

    const standardPublicConfigSchema = {
        [PublicConfigKey.ENV]: StringSchema,
        [PublicConfigKey.CLOUD_PROVIDER]: StringSchema,
        [PublicConfigKey.REGION]: StringSchema,
        [PublicConfigKey.IS_LOCAL]: BooleanSchema,
    };

    const allPublicConfigSchema = {
        ...standardPublicConfigSchema,
        ...(publicConfigSchema ?? ({} as Pub)),
    } as ConfigSchema<keyof Pub | keyof typeof PublicConfigKey>;

    const PublicConfigKeys = mapKeysToUpperSnake(allPublicConfigSchema);

    const SecretConfigKeys = mapKeysToUpperSnake(secretConfigSchema ?? ({} as Sec));

    const FeatureFlagKeys = mapKeysToUpperSnake(featureFlagSchema ?? ({} as FF));

    const AllConfigKeys = mapKeysToUpperSnake({
        ...allPublicConfigSchema,
        ...(secretConfigSchema ?? ({} as Sec)),
        ...(featureFlagSchema ?? ({} as FF)),
    });

    const allConfigSchema: ConfigSchema<
        keyof Pub | keyof typeof PublicConfigKey | keyof Sec | keyof typeof SecretConfigKey | keyof FF | keyof typeof FeatureFlagKey
    > = {
        ...allPublicConfigSchema,
        ...(secretConfigSchema ?? ({} as Sec)),
        ...(featureFlagSchema ?? ({} as FF)),
    };

    const { objectWithDeferFunctions: allConfigZodSchemaWithDeferFunctions, object: allConfigZodSchema } = generateConfigSchema(allConfigSchema);

    const parseConfig = (config: SchemaInputWithDeferFunctions<Pub & Sec & FF>): SchemaOutputWithDeferFunctions<Pub & Sec & FF> => {
        return handleSchemaValidationSync(allConfigZodSchemaWithDeferFunctions, config as any) as any;
    };

    const parseConfigKey = <
        K extends keyof Pub | keyof typeof PublicConfigKey | keyof Sec | keyof typeof SecretConfigKey | keyof FF | keyof typeof FeatureFlagKey,
    >(
        key: K,
        value: any,
    ): SchemaOutput<Pub & Sec & FF>[K] => {
        const schema = allConfigZodSchema.shape[key];
        if (typeof schema === 'object' && '~standard' in schema) {
            return handleSchemaValidationSync(schema, value) as any;
        } else {
            return value;
        }
    };

    const get = <K extends keyof Pub | keyof typeof PublicConfigKey | keyof Sec | keyof typeof SecretConfigKey | keyof FF | keyof typeof FeatureFlagKey>(
        _key: K,
    ): SchemaOutput<Pub & Sec & FF>[K] => {
        throw new SmooaiConfigError('Not implemented');
    };

    const _configType: SchemaOutput<Pub & Sec & FF> = {} as any;

    return {
        AllConfigKeys,
        PublicConfigKeys,
        SecretConfigKeys,
        FeatureFlagKeys,
        parseConfig,
        parseConfigKey,
        get,
        _configType,
    };
}

/**
 * Infers the TypeScript types from a configuration definition.
 * This utility type extracts the public keys, secret keys, feature flag keys, and input/output types
 * from a configuration definition created by defineConfig.
 *
 * @returns An object containing:
 *   - PublicConfigKeys: Type of public configuration keys
 *   - SecretConfigKeys: Type of secret configuration keys
 *   - FeatureFlagKeys: Type of feature flag keys
 *   - ConfigType: Type of the input configuration
 *   - ConfigTypeOutput: Type of the validated output configuration
 *
 * @example
 * // Define a configuration
 * const config = defineConfig({
 *   publicConfigSchema: {
 *     apiUrl: StringSchema,
 *     debugMode: BooleanSchema
 *   },
 *   secretConfigSchema: {
 *     apiKey: StringSchema
 *   },
 *   featureFlagSchema: {
 *     enableNewUI: BooleanSchema
 *   }
 * });
 *
 * // Infer types from the configuration
 * type ConfigTypes = InferConfigTypes<typeof config>;
 *
 * // Now you can use the inferred types:
 * type PublicKeys = ConfigTypes['PublicConfigKeys'];  // { API_URL: 'apiUrl', DEBUG_MODE: 'debugMode' }
 * type SecretKeys = ConfigTypes['SecretConfigKeys'];  // { API_KEY: 'apiKey' }
 * type FeatureFlags = ConfigTypes['FeatureFlagKeys']; // { ENABLE_NEW_UI: 'enableNewUI' }
 *
 * // Input type for parseConfig
 * type InputConfig = ConfigTypes['ConfigType'];
 * // {
 * //   apiUrl?: string | ((config: Record<string, any>) => string);
 * //   debugMode?: boolean | ((config: Record<string, any>) => boolean);
 * //   apiKey?: string | ((config: Record<string, any>) => string);
 * //   enableNewUI?: boolean | ((config: Record<string, any>) => boolean);
 * // }
 *
 * // Output type after parsing
 * type OutputConfig = ConfigTypes['ConfigTypeOutput'];
 * // {
 * //   apiUrl?: string;
 * //   debugMode?: boolean;
 * //   apiKey?: string;
 * //   enableNewUI?: boolean;
 * // }
 *
 * @example
 * // Using with structured configuration
 * const config = defineConfig({
 *   publicConfigSchema: {
 *     database: {
 *       '~standard': z.object({
 *         host: z.string(),
 *         port: z.number()
 *       })
 *     }
 *   }
 * });
 *
 * type ConfigTypes = InferConfigTypes<typeof config>;
 *
 * // Input type includes both direct values and functions
 * type InputConfig = ConfigTypes['ConfigType'];
 * // {
 * //   database?: {
 * //     host: string;
 * //     port: number;
 * //   } | ((config: Record<string, any>) => {
 * //     host: string;
 * //     port: number;
 * //   })
 * // }
 *
 * // Output type only includes the final values
 * type OutputConfig = ConfigTypes['ConfigTypeOutput'];
 * // {
 * //   database?: {
 * //     host: string;
 * //     port: number;
 * //   }
 * // }
 */
export type InferConfigTypes<T> = T extends {
    AllConfigKeys: infer AK;
    PublicConfigKeys: infer PK;
    SecretConfigKeys: infer SK;
    FeatureFlagKeys: infer FK;
    parseConfig: (input: infer CI) => infer CO;
    get: (key: infer _K) => infer _V;
    _configType: infer CT;
}
    ? {
          AllConfigKeys: AK;
          PublicConfigKeys: PK;
          SecretConfigKeys: SK;
          FeatureFlagKeys: FK;
          ConfigType: CI;
          ConfigTypeOutput: CO;
          ConfigTypeComputed: CT;
      }
    : never;
