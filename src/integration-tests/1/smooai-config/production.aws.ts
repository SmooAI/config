import type { InferConfigTypes } from '@/config/config';
import config from './config';

type configTypes = InferConfigTypes<typeof config>;
type ConfigTypeInput = configTypes['ConfigTypeInput'];

const { PublicConfigKeys, SecretConfigKeys } = config;

export default {
    [PublicConfigKeys.API_URL]: 'https://aws-api.example.com',
    [PublicConfigKeys.DATABASE]: (config) => ({
        ...config[PublicConfigKeys.DATABASE],
        host: 'aws-prod-db.example.com',
        poolSize: 100,
    }),
    [PublicConfigKeys.FEATURES]: (config) => ({
        ...config[PublicConfigKeys.FEATURES],
        rateLimiting: {
            ...(config[PublicConfigKeys.FEATURES]?.rateLimiting ?? {}),
            requestsPerMinute: 2000,
        },
    }),
} satisfies ConfigTypeInput;
