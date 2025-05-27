import zodToJsonSchema from 'zod-to-json-schema';
import { toJsonSchema as valibotToJsonSchema } from '@valibot/to-json-schema';
import type { Type as ArkType } from 'arktype';
import { Schema as EffectSchema } from 'effect';
import EffectJSONSchema from 'effect/JSONSchema';
import { StandardSchemaV1 } from '@standard-schema/spec';
import type { ZodType } from 'zod';
import type { BaseIssue, BaseSchema } from 'valibot';
import { SmooaiConfigError } from '@/utils';

export function standardSchemaToJson<I, O>(schema: StandardSchemaV1<I, O> | EffectSchema.Schema<O, I>) {
    if ('~standard' in schema) {
        const { vendor } = schema['~standard'];
        switch (vendor) {
            case 'zod':
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
