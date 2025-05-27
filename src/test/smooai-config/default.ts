import config from './config';
import type { InferConfigTypes } from '../../config';

type configTypes = InferConfigTypes<typeof config>;
type ConfigTypeInput = configTypes['ConfigTypeInput'];

const { PublicConfigKeys, SecretConfigKeys } = config;

export default {
    [PublicConfigKeys.MY_PUBLIC_API_KEY]: 'public',
    [SecretConfigKeys.MY_SECRET_API_KEY]: 'secret',
} as ConfigTypeInput;
