import { defineConfig, StringSchema, BooleanSchema, NumberSchema } from '@/config/config';
import { z } from 'zod';

export default defineConfig({
    publicConfigSchema: {
        apiUrl: StringSchema,
        maxRetries: NumberSchema,
        enableDebug: BooleanSchema,
        appName: StringSchema,
        database: z.object({
            host: z.string(),
            port: z.number().min(1).max(65535),
            ssl: z.boolean(),
        }),
    },

    secretConfigSchema: {
        apiKey: StringSchema,
        dbPassword: StringSchema,
        jwtSecret: StringSchema,
    },

    featureFlagSchema: {
        enableNewUI: BooleanSchema,
        enableBeta: BooleanSchema,
        maintenanceMode: BooleanSchema,
    },
});
