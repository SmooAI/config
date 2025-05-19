import { z } from 'zod';
import { defineConfig, StringSchema } from '../../../config';

const config = defineConfig({
    publicConfigSchema: {
        'myPublicApiKey': StringSchema,
    },
    secretConfigSchema: {
        'mySecretApiKey': StringSchema,
    }
})

export default config;