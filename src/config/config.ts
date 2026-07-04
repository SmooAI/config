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

/**
 * SMOODEV-2306 — the fourth config kind: **limits**.
 *
 * A limit is a NUMERIC value that resolves contextually (per user / segment /
 * org) through the SAME server-side segment evaluator as feature flags, and
 * is **never baked** — it always resolves live. Unlike a hard cap, a limit is
 * a soft, tunable target: the consuming code still applies its own hard clamp,
 * and the config value only tunes within `[min, max]`. `default` is the
 * fallback used by `getLimit()` and whenever resolution yields nothing usable.
 *
 * Declare limits with {@link defineLimit} inside `limitsSchema`:
 *
 * ```ts
 * const config = defineConfig({
 *   limitsSchema: {
 *     agentMaxIterations: defineLimit({ default: 12, min: 1, max: 50 }),
 *   },
 * });
 * ```
 *
 * The client resolves the raw/segmented number from the evaluator and then
 * applies {@link clampLimit} using this metadata.
 */
export interface LimitDefinition {
    readonly __smooLimit: true;
    /** Fallback value; also the value `getLimit()` returns when nothing is baked/resolved. */
    readonly default: number;
    /** Inclusive lower clamp bound. */
    readonly min?: number;
    /** Inclusive upper clamp bound. */
    readonly max?: number;
    /** Optional granularity the client snaps the resolved value to (nearest multiple), applied before clamping. */
    readonly step?: number;
}

/** Options accepted by {@link defineLimit}. */
export interface LimitSpec {
    default: number;
    min?: number;
    max?: number;
    step?: number;
}

type LimitsSchema<K extends string | number | symbol = string> = Record<K, LimitDefinition>;

/**
 * Declare a limit (numeric, segment-resolved, clamp-aware) for `limitsSchema`.
 * Validates the clamp metadata up front so a bad schema fails at definition
 * time rather than silently mis-clamping at runtime.
 */
export function defineLimit(spec: LimitSpec): LimitDefinition {
    const { default: def, min, max, step } = spec;
    if (typeof def !== 'number' || !Number.isFinite(def)) {
        throw new SmooaiConfigError(`defineLimit: \`default\` must be a finite number, got ${String(def)}`);
    }
    if (min !== undefined && max !== undefined && min > max) {
        throw new SmooaiConfigError(`defineLimit: \`min\` (${min}) must be <= \`max\` (${max})`);
    }
    if (min !== undefined && def < min) {
        throw new SmooaiConfigError(`defineLimit: \`default\` (${def}) must be >= \`min\` (${min})`);
    }
    if (max !== undefined && def > max) {
        throw new SmooaiConfigError(`defineLimit: \`default\` (${def}) must be <= \`max\` (${max})`);
    }
    if (step !== undefined && (!Number.isFinite(step) || step <= 0)) {
        throw new SmooaiConfigError(`defineLimit: \`step\` must be a positive number, got ${String(step)}`);
    }
    return { __smooLimit: true, default: def, min, max, step };
}

/**
 * Clamp a resolved (or raw) limit value into `[min, max]` using a
 * {@link LimitDefinition}. Non-numeric / non-finite input falls back to
 * `default`. `step` (if set) snaps to the nearest multiple before clamping.
 * Pure + deterministic — the client applies this after the server resolves
 * the segmented number.
 */
export function clampLimit(raw: unknown, def: LimitDefinition): number {
    // Only real numbers and non-empty numeric strings count as a value; null,
    // undefined, '', booleans, and junk fall back to `default` (note
    // `Number(null)` / `Number('')` are 0, which would otherwise slip through).
    let n: number;
    if (typeof raw === 'number') n = raw;
    else if (typeof raw === 'string' && raw.trim() !== '') n = Number(raw);
    else n = Number.NaN;
    if (!Number.isFinite(n)) n = def.default;
    if (def.step !== undefined && def.step > 0) n = Math.round(n / def.step) * def.step;
    if (def.min !== undefined) n = Math.max(def.min, n);
    if (def.max !== undefined) n = Math.min(def.max, n);
    return n;
}

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

/**
 * Convert a single-tier `ConfigSchema` to a JSON Schema object node with
 * `type: 'object'` + per-key `properties`. This is the SMOODEV-671 wire
 * format: each key gets a real JSON Schema node (e.g. `{ type: 'string' }`)
 * instead of the internal `'stringSchema'` sentinel string used by
 * `serializeConfigSchema`.
 */
function tierConfigSchemaToJsonSchema<T extends ConfigSchema>(configSchema: T): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(configSchema)) {
        if (value === StringSchema) {
            properties[key] = { type: 'string' };
        } else if (value === BooleanSchema) {
            properties[key] = { type: 'boolean' };
        } else if (value === NumberSchema) {
            properties[key] = { type: 'number' };
        } else if (value && typeof value === 'object' && '~standard' in (value as object)) {
            properties[key] = standardSchemaToJson(value as StandardSchemaV1);
        }
    }
    return { type: 'object', properties };
}

/**
 * Build the tiered JSON Schema used as the CLI push wire format
 * (SMOODEV-671). The /apps/config dashboard renders the schemas / feature
 * flags / values tabs off this shape — it expects three top-level tier
 * nodes, each a proper JSON Schema object with nested per-key schemas.
 *
 * Shape:
 *   {
 *     type: 'object',
 *     properties: {
 *       publicConfigSchema:  { type: 'object', properties: { apiUrl: { type: 'string' }, ... } },
 *       secretConfigSchema:  { type: 'object', properties: { ... } },
 *       featureFlagSchema:   { type: 'object', properties: { ... } }
 *     }
 *   }
 *
 * This is kept separate from `serializeConfigSchema` (which still emits the
 * flat `{ key: 'stringSchema' }` internal form) so local-runtime / source-
 * generator consumers that read `serializedAllConfigSchema` are unaffected.
 */
/**
 * Convert a `limitsSchema` tier to a JSON Schema object node. Each limit key
 * becomes a `{ type: 'number', default, minimum?, maximum?, multipleOf? }`
 * node so the config server / dashboard render limits as bounded numbers and
 * the clamp metadata rides along on the wire (SMOODEV-2306).
 */
function limitsSchemaToJsonSchema(limitsSchema: LimitsSchema): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(limitsSchema)) {
        const node: Record<string, unknown> = { type: 'number', default: def.default };
        if (def.min !== undefined) node.minimum = def.min;
        if (def.max !== undefined) node.maximum = def.max;
        if (def.step !== undefined) node.multipleOf = def.step;
        properties[key] = node;
    }
    return { type: 'object', properties };
}

export function serializeConfigSchemaToJsonSchema<
    Pub extends ConfigSchema,
    Sec extends ConfigSchema,
    FF extends ConfigSchema,
    Lim extends LimitsSchema,
>(tiers: {
    publicConfigSchema?: Pub | undefined;
    secretConfigSchema?: Sec | undefined;
    featureFlagSchema?: FF | undefined;
    limitsSchema?: Lim | undefined;
}): Record<string, unknown> {
    const { publicConfigSchema, secretConfigSchema, featureFlagSchema, limitsSchema } = tiers;
    return {
        type: 'object',
        properties: {
            publicConfigSchema: tierConfigSchemaToJsonSchema(publicConfigSchema ?? ({} as Pub)),
            secretConfigSchema: tierConfigSchemaToJsonSchema(secretConfigSchema ?? ({} as Sec)),
            featureFlagSchema: tierConfigSchemaToJsonSchema(featureFlagSchema ?? ({} as FF)),
            limitsSchema: limitsSchemaToJsonSchema(limitsSchema ?? ({} as Lim)),
        },
    };
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
 *   - serializedAllConfigSchema: Flat internal serialization (e.g. `{ apiUrl: 'stringSchema' }`) — kept for local runtime, source generators, and the Zod-regen path
 *   - serializedAllConfigSchemaJsonSchema: Tiered JSON Schema wire format used by `smooai-config push` and the /apps/config dashboard
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
function defineConfig<Pub extends ConfigSchema, Sec extends ConfigSchema, FF extends ConfigSchema, Lim extends LimitsSchema>({
    publicConfigSchema,
    secretConfigSchema,
    featureFlagSchema,
    limitsSchema,
}: {
    publicConfigSchema?: Pub | undefined;
    secretConfigSchema?: Sec | undefined;
    featureFlagSchema?: FF | undefined;
    limitsSchema?: Lim | undefined;
}) {
    if (!publicConfigSchema && !secretConfigSchema && !featureFlagSchema && !limitsSchema) {
        throw new SmooaiConfigError('At least one of publicConfigSchema, secretConfigSchema, featureFlagSchema, or limitsSchema must be provided');
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

    const LimitKeys = mapKeysToUpperSnake(limitsSchema ?? ({} as Lim));

    // Runtime map of limit key -> clamp metadata. Limits never bake and are
    // not part of `allConfigSchema` (their value kind is a LimitDefinition
    // object, not a Str/Bool/Num schema), so they're carried separately here
    // for the client/server limit accessors to clamp against.
    const _limitsMeta: Record<string, LimitDefinition> = { ...(limitsSchema ?? ({} as Lim)) };

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

    // SMOODEV-671: CLI `smooai-config push` reads this tiered JSON Schema
    // (not the flat `serializedAllConfigSchema`) so the /apps/config UI can
    // render proper schemas / feature-flag / values tabs. The flat form
    // stays intact for local-runtime and source-generator consumers.
    const serializedAllConfigSchemaJsonSchema = serializeConfigSchemaToJsonSchema({
        publicConfigSchema: allPublicConfigSchema as Pub,
        secretConfigSchema,
        featureFlagSchema,
        limitsSchema,
    });

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
        LimitKeys,
        _limitsMeta,
        serializedAllConfigSchema,
        serializedAllConfigSchemaJsonSchema,
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
    LimitKeys: infer LK;
    serializedAllConfigSchema: infer _SACS;
    serializedAllConfigSchemaJsonSchema?: infer _SJS;
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
          LimitKeys: LK;
          ConfigTypeInput: CIT;
          ConfigTypeOutput: COT;
          ConfigType: CT;
          ZodOutputType: ZOT;
          ZodOutputTypeWithDeferFunctions: ZOTDF;
      }
    : never;
