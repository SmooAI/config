import { resolve } from 'path';
import { defineConfig } from 'tsup';

export default defineConfig({
    entry: { cli: 'src/cli/index.ts' },
    outDir: 'dist',
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    splitting: false,
    sourcemap: true,
    clean: false, // Don't clean — shared dist/ with library build
    banner: {
        js: '#!/usr/bin/env node',
    },
    // Don't bundle node_modules — they're package dependencies
    // and will be available at runtime
    esbuildOptions(options) {
        options.jsx = 'automatic';
        // Shim react-devtools-core to avoid runtime dependency
        options.alias = {
            'react-devtools-core': resolve('src/cli/shims/react-devtools-core.ts'),
        };
    },
    // Output as .mjs for ESM
    outExtension() {
        return { js: '.mjs' };
    },
});
