import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        passWithNoTests: true,
        include: ['src/**/*.integration.test.ts'],
    },
});
