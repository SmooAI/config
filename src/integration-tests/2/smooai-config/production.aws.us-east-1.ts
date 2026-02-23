import type { InferConfigTypes } from '@/config/config';
import config from './config';

type configTypes = InferConfigTypes<typeof config>;
type ConfigTypeInput = configTypes['ConfigTypeInput'];

const { PublicConfigKeys } = config;

export default {
    [PublicConfigKeys.DATABASE]: (cfg) => ({
        ...cfg[PublicConfigKeys.DATABASE],
        host: 'us-east-1-db.example.com',
    }),
} satisfies ConfigTypeInput;
