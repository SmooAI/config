import { defineConfig, StringSchema, BooleanSchema, NumberSchema } from '@/config/config';
import { z } from 'zod';

export default defineConfig({
    publicConfigSchema: {
        // Basic schema types
        apiUrl: StringSchema,
        maxRetries: NumberSchema,
        enableDebug: BooleanSchema,

        // Structured configurations using Zod
        database: z.object({
            host: z.string(),
            port: z.number().min(1).max(65535),
            ssl: z.boolean().default(true),
            connectionTimeout: z.number().min(1000).max(30000),
            poolSize: z.number().min(1).max(100),
        }),

        // Feature configuration
        features: z.object({
            rateLimiting: z.object({
                enabled: z.boolean(),
                requestsPerMinute: z.number().min(1),
                burstSize: z.number().min(1),
            }),
            caching: z.object({
                enabled: z.boolean(),
                ttl: z.number().min(0),
                maxSize: z.number().min(1),
            }),
        }),
    },

    secretConfigSchema: {
        // Basic secret configurations
        apiKey: StringSchema,
        jwtSecret: StringSchema,

        // Structured secret configuration
        credentials: z.object({
            username: z.string().min(3),
            password: z.string().min(8),
            mfaEnabled: z.boolean(),
            allowedIps: z.array(
                z
                    .string()
                    .regex(
                        /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$|^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/,
                        'Invalid IP address',
                    ),
            ),
        }),

        // Encryption configuration
        encryption: z.object({
            algorithm: z.enum(['aes-256-gcm', 'chacha20-poly1305']),
            keyRotationDays: z.number().min(1).max(365),
            backupEnabled: z.boolean(),
        }),
    },

    featureFlagSchema: {
        // Basic feature flags
        enableNewUI: BooleanSchema,
        betaFeatures: BooleanSchema,

        // Structured feature flags
        experimentalFeatures: z.object({
            aiAssist: z.boolean(),
            darkMode: z.boolean(),
            performanceOptimizations: z.boolean(),
            rolloutPercentage: z.number().min(0).max(100),
        }),

        // A/B testing configuration
        abTesting: z.object({
            enabled: z.boolean(),
            testGroups: z.array(
                z.object({
                    name: z.string(),
                    percentage: z.number().min(0).max(100),
                    features: z.array(z.string()),
                }),
            ),
        }),
    },
});
