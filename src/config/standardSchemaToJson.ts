import { SmooaiConfigError } from '@/utils';
import { StandardSchemaV1 } from '@standard-schema/spec';
import { toJsonSchema as valibotToJsonSchema } from '@valibot/to-json-schema';
import type { Type as ArkType } from 'arktype';
import { Schema as EffectSchema } from 'effect';
import * as EffectJSONSchema from 'effect/JSONSchema';
import type { BaseIssue, BaseSchema } from 'valibot';
import type { ZodType } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

/**
 * Zod type names that cannot be serialized to JSON Schema for config.
 * Maps typeName to an actionable error message.
 */
const UNSUPPORTED_ZOD_TYPES: Record<string, string> = {
    ZodFunction: 'z.function() cannot be serialized to JSON Schema for config. Use a plain value type instead.',
    ZodPromise: 'z.promise() cannot be serialized to JSON Schema for config. Use a plain value type instead.',
    ZodVoid: 'z.void() cannot be serialized to JSON Schema for config. Use a plain value type instead.',
    ZodNever: 'z.never() cannot be serialized to JSON Schema for config. Use a plain value type instead.',
    ZodSymbol: 'z.symbol() cannot be serialized to JSON Schema for config. Use a plain value type instead.',
    ZodUndefined: 'z.undefined() cannot be serialized to JSON Schema for config. Use a plain value type instead.',
    ZodLazy: 'Recursive schemas (z.lazy()) are not supported in config. Flatten your schema structure.',
    ZodMap: 'z.map() is not representable in JSON Schema across all SDK languages. Use a Record or object type instead.',
    ZodSet: 'z.set() is not representable in JSON Schema across all SDK languages. Use an array type instead.',
    ZodBigInt: 'z.bigint() is not representable in JSON Schema across all SDK languages. Use a number or string type instead.',
    ZodDate: 'z.date() is not representable in JSON Schema across all SDK languages. Use a string with format "date-time" instead.',
};

const UNSUPPORTED_ZOD_TRANSFORMS: Record<string, string> = {
    ZodEffects: 'z.transform()/z.refine()/z.preprocess() performs runtime transformations lost in JSON Schema. Define config as plain types.',
    ZodPipeline: 'z.pipe() performs runtime transformations lost in JSON Schema. Define config as plain types.',
};

/**
 * Check a Zod schema for unsupported type names before conversion.
 * Recursively walks the schema tree to catch issues in nested schemas.
 */
function checkZodSchema(schema: ZodType, path: string = ''): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing internal Zod structure
    const def = (schema as any)?._def;
    if (!def) return;

    const typeName = def.typeName as string | undefined;
    if (typeName) {
        if (typeName in UNSUPPORTED_ZOD_TYPES) {
            throw new SmooaiConfigError(`${path ? `At ${path}: ` : ''}${UNSUPPORTED_ZOD_TYPES[typeName]}`);
        }
        if (typeName in UNSUPPORTED_ZOD_TRANSFORMS) {
            throw new SmooaiConfigError(`${path ? `At ${path}: ` : ''}${UNSUPPORTED_ZOD_TRANSFORMS[typeName]}`);
        }
    }

    // Recurse into common Zod internal structures
    if (def.innerType) checkZodSchema(def.innerType, path);
    if (def.schema) checkZodSchema(def.schema, path);
    if (def.left) checkZodSchema(def.left, path);
    if (def.right) checkZodSchema(def.right, path);
    if (def.options) {
        for (const opt of def.options) {
            if (opt && typeof opt === 'object' && '_def' in opt) {
                checkZodSchema(opt, path);
            }
        }
    }
    if (def.items) {
        for (const item of def.items) {
            if (item && typeof item === 'object' && '_def' in item) {
                checkZodSchema(item, path);
            }
        }
    }
    if (def.type) {
        if (typeof def.type === 'object' && '_def' in def.type) {
            checkZodSchema(def.type, path);
        }
    }
    // ZodObject shape
    if (def.shape) {
        const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
        if (shape && typeof shape === 'object') {
            for (const [key, value] of Object.entries(shape)) {
                if (value && typeof value === 'object' && '_def' in (value as object)) {
                    checkZodSchema(value as ZodType, `${path ? path + '.' : ''}${key}`);
                }
            }
        }
    }
}

export function standardSchemaToJson<I, O>(schema: StandardSchemaV1<I, O> | EffectSchema.Schema<O, I>) {
    if ('~standard' in schema) {
        const { vendor } = schema['~standard'];
        switch (vendor) {
            case 'zod':
                checkZodSchema(schema as ZodType);
                return zodToJsonSchema(schema as ZodType);
            case 'valibot':
                return valibotToJsonSchema(schema as BaseSchema<unknown, unknown, BaseIssue<unknown>>);
            case 'arktype':
                return (schema as ArkType).toJsonSchema();
            default:
                throw new SmooaiConfigError(`Cannot serialize validation schema for vendor: ${vendor}`);
        }
    } else {
        if (EffectSchema.isSchema(schema)) {
            return EffectJSONSchema.make(schema);
        }
        throw new SmooaiConfigError(`Cannot serialize validation schema of unknown type: ${schema}`);
    }
}
