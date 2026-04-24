function defineConfig<T extends { serializedAllConfigSchema: Record<string, unknown> }>(input: T): T {
    return input;
}

export default defineConfig({
    serializedAllConfigSchema: {
        type: 'object',
        properties: {
            DEBUG: { type: 'boolean' },
        },
    },
    schemaName: 'fixture-via-default',
});
