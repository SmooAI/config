import { z } from 'zod';
import { generateConfigValuesSchema, generateConfigValuesTypeWithCustomSchemas, InferConfigValuesFromCustomSchemas, InferConfigValuesType, InferConfigValuesWithCustomSchemasType } from '../../../ConfigValues';
import { extendPublicConfigKey } from '../../../PublicConfigKey';
import { extendSecretConfigKey } from '../../../SecretConfigKey';

export const PublicConfigKey = extendPublicConfigKey({
    MY_PUBLIC_API_KEY: 'MY_PUBLIC_API_KEY',
} as const);

export const SecretConfigKey = extendSecretConfigKey({
    MY_SECRET_API_KEY: 'MY_SECRET_API_KEY',
} as const);

export const CustomSchemas = generateConfigValuesTypeWithCustomSchemas<typeof PublicConfigKey, typeof SecretConfigKey>(
    {
        MY_PUBLIC_API_KEY: z.object({
            key: z.string(),
            secret: z.string()
        }),
    }
);
export type ConfigValues = InferConfigValuesFromCustomSchemas<typeof CustomSchemas>;
