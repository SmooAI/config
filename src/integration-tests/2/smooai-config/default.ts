import type { InferConfigTypes } from '@/config/config';
import config from './config';

type configTypes = InferConfigTypes<typeof config>;
type ConfigTypeInput = configTypes['ConfigTypeInput'];

const { PublicConfigKeys, SecretConfigKeys, FeatureFlagKeys } = config;

export default {
    [PublicConfigKeys.API_URL]: 'http://localhost:3000',
    [PublicConfigKeys.MAX_RETRIES]: 3,
    [PublicConfigKeys.ENABLE_DEBUG]: true,
    [PublicConfigKeys.APP_NAME]: 'default-app',
    [PublicConfigKeys.DATABASE]: {
        host: 'localhost',
        port: 5432,
        ssl: false,
    },

    [SecretConfigKeys.API_KEY]: 'default-api-key',
    [SecretConfigKeys.DB_PASSWORD]: 'default-db-pass',
    [SecretConfigKeys.JWT_SECRET]: 'default-jwt-secret',

    [FeatureFlagKeys.ENABLE_NEW_UI]: false,
    [FeatureFlagKeys.ENABLE_BETA]: false,
    [FeatureFlagKeys.MAINTENANCE_MODE]: false,
} satisfies Required<ConfigTypeInput>;
