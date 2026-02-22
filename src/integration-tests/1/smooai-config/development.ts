import type { InferConfigTypes } from '@/config/config';
import config from './config';

type configTypes = InferConfigTypes<typeof config>;
type ConfigTypeInput = configTypes['ConfigTypeInput'];

const { PublicConfigKeys, SecretConfigKeys, FeatureFlagKeys } = config;

export default {
    [PublicConfigKeys.API_URL]: 'http://dev-api.example.com',
    [PublicConfigKeys.ENABLE_DEBUG]: true,
    [PublicConfigKeys.DATABASE]: {
        host: 'dev-db.example.com',
        port: 5432,
        ssl: true,
        connectionTimeout: 5000,
        poolSize: 10,
    },
    [PublicConfigKeys.FEATURES]: {
        rateLimiting: {
            enabled: true,
            requestsPerMinute: 120,
            burstSize: 10,
        },
        caching: {
            enabled: true,
            ttl: 3600,
            maxSize: 1000,
        },
    },

    // Feature flags
    [FeatureFlagKeys.ENABLE_NEW_UI]: true,
    [FeatureFlagKeys.BETA_FEATURES]: true,
    [FeatureFlagKeys.EXPERIMENTAL_FEATURES]: {
        aiAssist: true,
        darkMode: true,
        performanceOptimizations: false,
        rolloutPercentage: 50,
    },
    [FeatureFlagKeys.AB_TESTING]: {
        enabled: true,
        testGroups: [
            {
                name: 'control',
                percentage: 50,
                features: [],
            },
            {
                name: 'experimental',
                percentage: 50,
                features: ['newUI', 'darkMode'],
            },
        ],
    },
} satisfies ConfigTypeInput;
