// SMOODEV-643 reproducer: explicit `ReturnType<typeof ...>` annotation
// crashes tsx's lightweight TS stripper (`Missing initializer in const
// declaration`). jiti handles it fine, which is exactly why we switched.
//
// We stub out defineConfig locally so the fixture has no dep on the parent
// package graph — the loader only reads `serializedAllConfigSchema` + optional
// `schemaName`, and this minimal shape is enough.

type Fake = {
    serializedAllConfigSchema: Record<string, unknown>;
};

function defineConfig(input: { serializedAllConfigSchema: Record<string, unknown> }): Fake {
    return input;
}

const config: ReturnType<typeof defineConfig> = defineConfig({
    serializedAllConfigSchema: {
        type: 'object',
        properties: {
            API_URL: { type: 'string' },
        },
    },
});

export const schemaName = 'fixture-annotated';

export default config;
