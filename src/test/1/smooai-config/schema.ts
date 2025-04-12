import { generateConfigValuesSchema, InferConfigValuesType } from '../../../ConfigValues';
import { extendPublicConfigKey } from '../../../PublicConfigKey';
import { extendSecretConfigKey } from '../../../SecretConfigKey';

export const PublicConfigKey = extendPublicConfigKey({
    MY_PUBLIC_API_KEY: 'MY_PUBLIC_API_KEY',
} as const);

export const SecretConfigKey = extendSecretConfigKey({
    MY_SECRET_API_KEY: 'MY_SECRET_API_KEY',
} as const);

export const ConfigValues = generateConfigValuesSchema(PublicConfigKey, SecretConfigKey);
export type ConfigValues = InferConfigValuesType<typeof PublicConfigKey, typeof SecretConfigKey>;