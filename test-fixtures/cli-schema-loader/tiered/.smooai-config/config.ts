// SMOODEV-671 fixture: config modules built against @smooai/config >= 5.x
// expose both the flat `serializedAllConfigSchema` (internal runtime form)
// and the tiered `serializedAllConfigSchemaJsonSchema` (JSON Schema wire
// format). The CLI loader must prefer the tiered one when both are present.

function defineConfig<T extends Record<string, unknown>>(input: T): T {
    return input;
}

const config = defineConfig({
    // Legacy flat form — what pre-SMOODEV-671 servers stored.
    serializedAllConfigSchema: {
        API_URL: 'stringSchema',
    },
    // New tiered JSON Schema — what the /apps/config UI expects.
    serializedAllConfigSchemaJsonSchema: {
        type: 'object',
        properties: {
            publicConfigSchema: {
                type: 'object',
                properties: {
                    API_URL: { type: 'string' },
                },
            },
            secretConfigSchema: { type: 'object', properties: {} },
            featureFlagSchema: { type: 'object', properties: {} },
        },
    },
    schemaName: 'fixture-tiered',
});

export default config;
