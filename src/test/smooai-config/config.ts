import { defineConfig, StringSchema } from '@/config/config';

export default defineConfig({
    publicConfigSchema: {
        myPublicApiKey: StringSchema,
    },
    secretConfigSchema: {
        mySecretApiKey: StringSchema,
    },
});
