import type { InferConfigTypes } from '@/config/config';
import config from './config';

type configTypes = InferConfigTypes<typeof config>;
type ConfigTypeInput = configTypes['ConfigTypeInput'];

const { PublicConfigKeys } = config;

export default {
    [PublicConfigKeys.API_URL]: 'https://aws-api.example.com',
    [PublicConfigKeys.DATABASE]: (cfg) => ({
        ...cfg[PublicConfigKeys.DATABASE],
        host: 'aws-prod-db.example.com',
    }),
} satisfies ConfigTypeInput;
