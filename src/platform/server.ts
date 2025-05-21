import { findAndProcessFileConfig } from '@/config/findAndProcessFileConfig';
import { InferConfigTypes } from '@/config/config';
let configInstance: Awaited<ReturnType<typeof findAndProcessFileConfig>> | null = null;

async function getConfig() {
    if (!configInstance) {
        configInstance = await findAndProcessFileConfig();
    }
    return configInstance;
}

async function buildConfigObject() {
    const config = await getConfig();
    type AllConfigKeys = InferConfigTypes<typeof config.configSchema>['AllConfigKeys'];
    return {
        ...config.configSchema,
        get: (key: AllConfigKeys[keyof AllConfigKeys]) => config.config[key],
    } satisfies typeof config.configSchema;
}

const builtConfig = await buildConfigObject();

export default builtConfig;
