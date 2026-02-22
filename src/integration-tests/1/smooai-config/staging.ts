import type { InferConfigTypes } from '@/config/config';
import config from './config';

type configTypes = InferConfigTypes<typeof config>;
type ConfigTypeInput = configTypes['ConfigTypeInput'];

const { PublicConfigKeys, SecretConfigKeys } = config;

export default {
    [PublicConfigKeys.API_URL]: 'https://staging-api.example.com',
    [PublicConfigKeys.ENABLE_DEBUG]: false,
    [PublicConfigKeys.DATABASE]: (config) => ({
        ...config[PublicConfigKeys.DATABASE],
        host: 'staging-db.example.com',
        ssl: true,
        poolSize: 20,
    }),
    [PublicConfigKeys.FEATURES]: (config) => ({
        ...config[PublicConfigKeys.FEATURES],
        rateLimiting: {
            ...config[PublicConfigKeys.FEATURES]?.rateLimiting,
            requestsPerMinute: 300,
        },
        caching: {
            ...config[PublicConfigKeys.FEATURES]?.caching,
            maxSize: 5000,
        },
    }),
} satisfies ConfigTypeInput;
