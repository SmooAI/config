import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig, defaultExclude } from 'vitest/config';

export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        passWithNoTests: true,
        exclude: [...defaultExclude, 'src/**/*.integration.test.ts'],
    },
});
