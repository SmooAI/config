import type { InferConfigTypes } from '@/config/config';
import config from './config';

type configTypes = InferConfigTypes<typeof config>;
type ConfigTypeInput = configTypes['ConfigTypeInput'];

const { PublicConfigKeys, SecretConfigKeys, FeatureFlagKeys } = config;

export default {
    [PublicConfigKeys.API_URL]: 'https://api.example.com',
    [PublicConfigKeys.ENABLE_DEBUG]: false,
    [PublicConfigKeys.MAX_RETRIES]: 5,
    [PublicConfigKeys.DATABASE]: {
        host: 'prod-db.example.com',
        port: 5432,
        ssl: true,
        poolSize: 50,
        connectionTimeout: 10000,
    },
    [PublicConfigKeys.FEATURES]: {
        rateLimiting: {
            enabled: true,
            requestsPerMinute: 1000,
            burstSize: 50,
        },
        caching: {
            enabled: true,
            maxSize: 10000,
            ttl: 7200,
        },
    },

    // Feature flags
    [FeatureFlagKeys.ENABLE_NEW_UI]: false,
    [FeatureFlagKeys.BETA_FEATURES]: false,
    [FeatureFlagKeys.EXPERIMENTAL_FEATURES]: {
        aiAssist: false,
        darkMode: false,
        performanceOptimizations: true,
        rolloutPercentage: 0,
    },
    [FeatureFlagKeys.AB_TESTING]: {
        enabled: false,
        testGroups: [
            {
                name: 'control',
                percentage: 100,
                features: [],
            },
        ],
    },
} satisfies ConfigTypeInput;
