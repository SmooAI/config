// SMOODEV-671 fallback fixture: a legacy config that only exposes the flat
// `serializedAllConfigSchema` property (e.g. a project pinned to an older
// `@smooai/config`). The loader should still push it rather than bail.

function defineConfig<T extends Record<string, unknown>>(input: T): T {
    return input;
}

const config = defineConfig({
    serializedAllConfigSchema: {
        type: 'object',
        properties: {
            LEGACY_KEY: { type: 'string' },
        },
    },
    schemaName: 'fixture-legacy-flat',
});

export default config;
