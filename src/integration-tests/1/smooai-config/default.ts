import config from './config';
import type { InferConfigTypes } from '@/config/config';

type configTypes = InferConfigTypes<typeof config>;
type ConfigTypeInput = configTypes['ConfigTypeInput'];

const { PublicConfigKeys, SecretConfigKeys, FeatureFlagKeys } = config;

export default {
    // Public config
    [PublicConfigKeys.API_URL]: 'http://localhost:3000',
    [PublicConfigKeys.MAX_RETRIES]: 3,
    [PublicConfigKeys.ENABLE_DEBUG]: true,
    [PublicConfigKeys.DATABASE]: {
        host: 'localhost',
        port: 5432,
        ssl: false,
        connectionTimeout: 5000,
        poolSize: 10,
    },
    [PublicConfigKeys.FEATURES]: {
        rateLimiting: {
            enabled: true,
            requestsPerMinute: 60,
            burstSize: 10,
        },
        caching: {
            enabled: true,
            ttl: 3600,
            maxSize: 1000,
        },
    },

    // Secret config
    [SecretConfigKeys.API_KEY]: 'dev-api-key',
    [SecretConfigKeys.JWT_SECRET]: 'dev-jwt-secret',
    [SecretConfigKeys.CREDENTIALS]: {
        username: 'admin',
        password: 'admin123',
        mfaEnabled: false,
        allowedIps: ['127.0.0.1'],
    },
    [SecretConfigKeys.ENCRYPTION]: {
        algorithm: 'aes-256-gcm',
        keyRotationDays: 30,
        backupEnabled: true,
    },

    // Feature flags
    [FeatureFlagKeys.ENABLE_NEW_UI]: false,
    [FeatureFlagKeys.BETA_FEATURES]: false,
    [FeatureFlagKeys.EXPERIMENTAL_FEATURES]: {
        aiAssist: false,
        darkMode: false,
        performanceOptimizations: false,
        rolloutPercentage: 0,
    },
    [FeatureFlagKeys.AB_TESTING]: {
        enabled: false,
        testGroups: [
            {
                name: 'control',
                percentage: 50,
                features: [],
            },
            {
                name: 'experimental',
                percentage: 50,
                features: [],
            },
        ],
    },
} satisfies Required<ConfigTypeInput>;
