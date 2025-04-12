import { ConfigValues, PublicConfigKey, SecretConfigKey } from './schema';

export const defaultConfigValues: ConfigValues = {
    [PublicConfigKey.MY_PUBLIC_API_KEY]: 'public',
    [SecretConfigKey.MY_SECRET_API_KEY]: 'secret',
};
