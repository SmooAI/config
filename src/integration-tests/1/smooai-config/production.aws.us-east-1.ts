import type { InferConfigTypes } from '@/config/config';
import config from './config';

type configTypes = InferConfigTypes<typeof config>;
type ConfigTypeInput = configTypes['ConfigTypeInput'];

const { PublicConfigKeys, SecretConfigKeys } = config;

export default {
    [PublicConfigKeys.API_URL]: 'https://us-east-1-api.example.com',
    [PublicConfigKeys.DATABASE]: (config) => ({
        ...config[PublicConfigKeys.DATABASE],
        host: 'us-east-1-db.example.com',
        connectionTimeout: 8000,
    }),
} satisfies ConfigTypeInput;
