import { FeatureFlagKey } from '@/config/FeatureFlagKey';
import { PublicConfigKey } from '@/config/PublicConfigKey';
import { SecretConfigKey } from '@/config/SecretConfigKey';
import { convertKeyToUpperSnakeCase, SmooaiConfigError, UnionToUpperSnake } from '@/utils';
/* eslint-disable @typescript-eslint/no-explicit-any -- ok */
import { StandardSchemaV1 } from '@standard-schema/spec';
import { jsonSchemaToZod } from 'json-schema-to-zod';
import { z } from 'zod';
import { standardSchemaToJson } from './standardSchemaToJson';

type DeepPartial<T> = T extends object
    ? {
          [P in keyof T]?: DeepPartial<T[P]>;
      }
    : T;

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

type ConfigSchema<K extends string | number | symbol = string> = Record<K, StringSchema | BooleanSchema | NumberSchema | StandardSchemaV1>;

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
          ? StandardSchemaV1.InferInput<E> | ((config: SchemaOutput<S>) => DeepPartial<StandardSchemaV1.InferInput<E>>)
          : never;

type InputTypeWithDeferFunctions<S extends ConfigSchema, E> = E extends StringSchema
    ? string | ((config: SchemaInput<S>) => string)
    : E extends BooleanSchema
      ? boolean | ((config: SchemaInput<S>) => boolean)
      : E extends NumberSchema
        ? number | ((config: SchemaInput<S>) => number)
        : E extends StandardSchemaV1
          ? StandardSchemaV1.InferInput<E> | ((config: SchemaInput<S>) => DeepPartial<StandardSchemaV1.InferInput<E>>)
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

type ZodOutputTypeRecord<T extends ConfigSchema> = {
    [K in keyof T]: z.ZodType<OutputType<T[K]>>;
};

type ZodOutputType<T extends ConfigSchema> = z.ZodObject<ZodOutputTypeRecord<T>>;

type ZodOutputTypeWithDeferFunctionsRecord<T extends ConfigSchema> = {
    [K in keyof T]: z.ZodType<OuputTypeWithDeferFunctions<T, T[K]>>;
};

type ZodOutputTypeWithDeferFunctions<T extends ConfigSchema> = z.ZodObject<ZodOutputTypeWithDeferFunctionsRecord<T>>;

function handleStandardSchemaValidation(key: string, schema: StandardSchemaV1): (val: any, ctx: z.RefinementCtx) => any {
    return (val, ctx) => {
        if (val && schema && typeof schema === 'object' && '~standard' in schema) {
            const result = schema['~standard'].validate(val);
            if (result instanceof Promise) {
                ctx.addIssue({
                    code: 'custom',
                    message: 'Asynchronous validation is not supported, please use a validation library that supports synchronous validation.',
                });
            } else if (result.issues) {
                result.issues.forEach((issue) => {
                    ctx.addIssue({
                        code: 'custom',
                        message: issue.message,
                        path: [key, ...(Array.isArray(issue.path) ? issue.path : [issue.path])],
                    });
                });
            } else {
                return result.value;
            }
        }
        return val;
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

type SeralizedConfigSchema<K extends string | number | symbol = string> = Record<K, 'stringSchema' | 'booleanSchema' | 'numberSchema' | any>;

export function serializeConfigSchema<T extends ConfigSchema>(configSchema: T) {
    return Object.entries(configSchema).reduce((acc, [key, value]) => {
        if (value === StringSchema) {
            (acc as any)[key] = 'stringSchema';
        } else if (value === BooleanSchema) {
            (acc as any)[key] = 'booleanSchema';
        } else if (value === NumberSchema) {
            (acc as any)[key] = 'numberSchema';
        } else if (value['~standard']) {
            (acc as any)[key] = standardSchemaToJson(value);
        }
        return acc;
    }, {} as ZodOutputType<T>);
}

export function deserializeConfigSchema<T extends SeralizedConfigSchema>(configSchema: T) {
    return Object.entries(configSchema).reduce((acc, [key, value]) => {
        if (value === 'stringSchema') {
            (acc as any)[key] = StringSchema;
        } else if (value === 'booleanSchema') {
            (acc as any)[key] = BooleanSchema;
        } else if (value === 'numberSchema') {
            (acc as any)[key] = NumberSchema;
        } else {
            try {
                (acc as any)[key] = jsonSchemaToZod(value);
            } catch (e) {
                throw new SmooaiConfigError(`Failed to deserialize config schema for key ${key}: ${e}`);
            }
        }
        return acc;
    }, {} as ConfigSchema);
}

export function generateConfigSchema<T extends ConfigSchema>(configSchema: T) {
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
    }, {} as ZodOutputTypeRecord<T>);

    const recordSchemaWithDeferFunctions = Object.entries(configSchema).reduce((acc, [key, value]) => {
        if (value === StringSchema) {
            (acc as any)[key] = z.union([z.function(), z.coerce.string()]).optional();
        } else if (value === BooleanSchema) {
            (acc as any)[key] = z.union([z.function(), coerceBooleanSchema]).optional();
        } else if (value === NumberSchema) {
            (acc as any)[key] = z.union([z.function(), z.coerce.number()]).optional();
        } else {
            (acc as any)[key] = z
                .union([z.function(), z.custom<StandardSchemaV1.InferInput<typeof value>>().superRefine(handleStandardSchemaValidation(key, value))])
                .optional();
        }
        return acc;
    }, {} as ZodOutputTypeWithDeferFunctionsRecord<T>);

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

export /**
 * Creates a configuration definition with public, secret, and feature flag configuration schemas.
 * This function generates type-safe configuration keys and validation schemas.
 *
 * @param publicConfigSchema - Schema definition for public configuration values
 * @param secretConfigSchema - Schema definition for secret configuration values
 * @param featureFlagSchema - Schema definition for feature flag configuration values
 * @returns An object containing:
 *   - AllConfigKeys: Object mapping all configuration keys to their snake_case versions
 *   - PublicConfigKeys: Object mapping public configuration keys to their snake_case versions
 *   - SecretConfigKeys: Object mapping secret configuration keys to their snake_case versions
 *   - FeatureFlagKeys: Object mapping feature flag keys to their snake_case versions
 *   - serializedAllConfigSchema: Serialized version of the complete configuration schema
 *   - _configTypeInput: Type helper for input configuration
 *   - _configTypeOutput: Type helper for output configuration
 *   - _configType: Type helper for configuration
 *   - _zodOutputType: Type helper for Zod output
 *   - _zodOutputTypeWithDeferFunctions: Type helper for Zod output with defer functions
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
 * // Access configuration keys
 * const { PublicConfigKeys, SecretConfigKeys, FeatureFlagKeys } = config;
 *
 * // Use in configuration files
 * export default {
 *   [PublicConfigKeys.API_URL]: 'https://api.example.com',
 *   [PublicConfigKeys.DEBUG_MODE]: true,
 *   [SecretConfigKeys.API_KEY]: 'secret-key',
 *   [FeatureFlagKeys.ENABLE_NEW_UI]: true
 * };
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
 * // Use in configuration files with defer functions
 * export default {
 *   [PublicConfigKeys.DATABASE]: (config) => ({
 *     host: 'localhost',
 *     port: 5432,
 *     credentials: {
 *       username: 'admin',
 *       password: 'secret'
 *     }
 *   })
 * };
 */
function defineConfig<Pub extends ConfigSchema, Sec extends ConfigSchema, FF extends ConfigSchema>({
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

    type StandardPublicConfigSchema = {
        [PublicConfigKey.ENV]: StringSchema;
        [PublicConfigKey.CLOUD_PROVIDER]: StringSchema;
        [PublicConfigKey.REGION]: StringSchema;
        [PublicConfigKey.IS_LOCAL]: BooleanSchema;
    };

    const standardPublicConfigSchema: StandardPublicConfigSchema = {
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

    const serializedAllConfigSchema = serializeConfigSchema(allConfigSchema);

    // const { objectWithDeferFunctions: allConfigZodSchemaWithDeferFunctions, object: allConfigZodSchema } = generateConfigSchema(allConfigSchema);

    // const parseConfig = (
    //     config: SchemaInputWithDeferFunctions<Pub & Sec & FF>,
    // ): SchemaOutputWithDeferFunctions<StandardPublicConfigSchema & Pub & Sec & FF> => {
    //     return handleSchemaValidationSync(allConfigZodSchemaWithDeferFunctions, config as any) as any;
    // };

    // const parseConfigKey = <
    //     K extends keyof Pub | keyof typeof PublicConfigKey | keyof Sec | keyof typeof SecretConfigKey | keyof FF | keyof typeof FeatureFlagKey,
    // >(
    //     key: K,
    //     value: any,
    // ): SchemaOutputWithDeferFunctions<StandardPublicConfigSchema & Pub & Sec & FF>[K] => {
    //     const schema = allConfigZodSchema.shape[key];
    //     if (typeof schema === 'object' && '~standard' in schema) {
    //         return handleSchemaValidationSync(schema, value) as any;
    //     } else {
    //         return value;
    //     }
    // };

    const _configTypeInput: SchemaInputWithDeferFunctions<Pub & Sec & FF> = {} as any;
    const _configTypeOutput: SchemaOutputWithDeferFunctions<StandardPublicConfigSchema & Pub & Sec & FF> = {} as any;
    const _configType: SchemaOutput<StandardPublicConfigSchema & Pub & Sec & FF> = {} as any;
    const _zodOutputType: ZodOutputType<StandardPublicConfigSchema & Pub & Sec & FF> = {} as any;
    const _zodOutputTypeWithDeferFunctions: ZodOutputTypeWithDeferFunctions<StandardPublicConfigSchema & Pub & Sec & FF> = {} as any;

    return {
        AllConfigKeys,
        PublicConfigKeys,
        SecretConfigKeys,
        FeatureFlagKeys,
        serializedAllConfigSchema,
        _configTypeInput,
        _configTypeOutput,
        _configType,
        _zodOutputType,
        _zodOutputTypeWithDeferFunctions,
    };
}

/**
 * Infers the TypeScript types from a configuration definition.
 * This utility type extracts the configuration keys and type helpers from a configuration definition created by defineConfig.
 *
 * @returns An object containing:
 *   - AllConfigKeys: Type of all configuration keys
 *   - PublicConfigKeys: Type of public configuration keys
 *   - SecretConfigKeys: Type of secret configuration keys
 *   - FeatureFlagKeys: Type of feature flag keys
 *   - ConfigTypeInput: Type helper for input configuration
 *   - ConfigTypeOutput: Type helper for output configuration
 *   - ConfigType: Type helper for configuration
 *   - ZodOutputType: Type helper for Zod output
 *   - ZodOutputTypeWithDeferFunctions: Type helper for Zod output with defer functions
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
 * type AllKeys = ConfigTypes['AllConfigKeys'];  // { API_URL: 'apiUrl', DEBUG_MODE: 'debugMode', API_KEY: 'apiKey', ENABLE_NEW_UI: 'enableNewUI' }
 * type PublicKeys = ConfigTypes['PublicConfigKeys'];  // { API_URL: 'apiUrl', DEBUG_MODE: 'debugMode' }
 * type SecretKeys = ConfigTypes['SecretConfigKeys'];  // { API_KEY: 'apiKey' }
 * type FeatureFlags = ConfigTypes['FeatureFlagKeys']; // { ENABLE_NEW_UI: 'enableNewUI' }
 *
 * // Type helpers for configuration
 * type InputConfig = ConfigTypes['ConfigTypeInput'];
 * type OutputConfig = ConfigTypes['ConfigTypeOutput'];
 * type ConfigType = ConfigTypes['ConfigType'];
 * type ZodOutput = ConfigTypes['ZodOutputType'];
 * type ZodOutputWithDefer = ConfigTypes['ZodOutputTypeWithDeferFunctions'];
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
 * // Type helpers for structured configuration
 * type InputConfig = ConfigTypes['ConfigTypeInput'];
 * type OutputConfig = ConfigTypes['ConfigTypeOutput'];
 * type ConfigType = ConfigTypes['ConfigType'];
 * type ZodOutput = ConfigTypes['ZodOutputType'];
 * type ZodOutputWithDefer = ConfigTypes['ZodOutputTypeWithDeferFunctions'];
 */
export type InferConfigTypes<T> = T extends {
    AllConfigKeys: infer AK;
    PublicConfigKeys: infer PK;
    SecretConfigKeys: infer SK;
    FeatureFlagKeys: infer FK;
    serializedAllConfigSchema: infer _SACS;
    _configType: infer CT;
    _configTypeInput: infer CIT;
    _configTypeOutput: infer COT;
    _zodOutputType: infer ZOT;
    _zodOutputTypeWithDeferFunctions: infer ZOTDF;
}
    ? {
          AllConfigKeys: AK;
          PublicConfigKeys: PK;
          SecretConfigKeys: SK;
          FeatureFlagKeys: FK;
          ConfigTypeInput: CIT;
          ConfigTypeOutput: COT;
          ConfigType: CT;
          ZodOutputType: ZOT;
          ZodOutputTypeWithDeferFunctions: ZOTDF;
      }
    : never;
