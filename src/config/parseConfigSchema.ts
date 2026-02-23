import { handleSchemaValidationSync } from '@smooai/utils/validation/standardSchema';
/* eslint-disable @typescript-eslint/no-explicit-any -- ok */
import { defineConfig, deserializeConfigSchema, generateConfigSchema, InferConfigTypes } from './config';

export function generateZodSchemas<Schema extends ReturnType<typeof defineConfig>>(
    configSchema: Schema,
): {
    allConfigZodSchemaWithDeferFunctions: InferConfigTypes<Schema>['ZodOutputTypeWithDeferFunctions'];
    allConfigZodSchema: InferConfigTypes<Schema>['ZodOutputType'];
} {
    const deserializedConfigSchema = deserializeConfigSchema(configSchema.serializedAllConfigSchema);
    const { objectWithDeferFunctions: allConfigZodSchemaWithDeferFunctions, object: allConfigZodSchema } = generateConfigSchema(deserializedConfigSchema);
    return {
        allConfigZodSchemaWithDeferFunctions,
        allConfigZodSchema,
    } as any;
}

export function parseConfig<Schema extends ReturnType<typeof defineConfig>>(
    allConfigZodSchemaWithDeferFunctions: InferConfigTypes<Schema>['ZodOutputTypeWithDeferFunctions'],
    config: InferConfigTypes<Schema>['ConfigTypeInput'],
) {
    return handleSchemaValidationSync(allConfigZodSchemaWithDeferFunctions, config as any) as any;
}

export function parseConfigKey<Schema extends ReturnType<typeof defineConfig>>(
    allConfigZodSchema: InferConfigTypes<Schema>['ZodOutputType'],
    key: any,
    value: any,
) {
    const schema = allConfigZodSchema.shape[key];
    if (typeof schema === 'object' && '~standard' in schema) {
        return handleSchemaValidationSync(schema, value) as any;
    } else {
        return value;
    }
}
