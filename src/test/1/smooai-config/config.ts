import { defineConfig, StringSchema } from '../../../config';

export default defineConfig({
    publicConfigSchema: {
        myPublicApiKey: StringSchema,
    },
    secretConfigSchema: {
        mySecretApiKey: StringSchema,
    },
});
