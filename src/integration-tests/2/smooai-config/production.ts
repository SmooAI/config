import type { InferConfigTypes } from '@/config/config';
import config from './config';

type configTypes = InferConfigTypes<typeof config>;
type ConfigTypeInput = configTypes['ConfigTypeInput'];

const { PublicConfigKeys, SecretConfigKeys, FeatureFlagKeys } = config;

export default {
    [PublicConfigKeys.API_URL]: 'https://api.example.com',
    [PublicConfigKeys.MAX_RETRIES]: 5,
    [PublicConfigKeys.ENABLE_DEBUG]: false,
    [PublicConfigKeys.APP_NAME]: 'prod-app',
    [PublicConfigKeys.DATABASE]: {
        host: 'prod-db.example.com',
        port: 5432,
        ssl: true,
    },

    [SecretConfigKeys.API_KEY]: 'prod-api-key-secret',
    [SecretConfigKeys.DB_PASSWORD]: 'prod-db-pass-secret',
    [SecretConfigKeys.JWT_SECRET]: 'prod-jwt-secret',

    [FeatureFlagKeys.ENABLE_NEW_UI]: false,
    [FeatureFlagKeys.ENABLE_BETA]: false,
    [FeatureFlagKeys.MAINTENANCE_MODE]: false,
} satisfies ConfigTypeInput;
