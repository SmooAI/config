import type { InferConfigTypes } from '@/config/config';
import config from './config';

type configTypes = InferConfigTypes<typeof config>;
type ConfigTypeInput = configTypes['ConfigTypeInput'];

const { PublicConfigKeys, FeatureFlagKeys } = config;

export default {
    [PublicConfigKeys.API_URL]: 'http://dev-api.example.com',
    [PublicConfigKeys.ENABLE_DEBUG]: true,
    [PublicConfigKeys.APP_NAME]: 'dev-app',

    [FeatureFlagKeys.ENABLE_NEW_UI]: true,
    [FeatureFlagKeys.ENABLE_BETA]: true,
} satisfies ConfigTypeInput;
