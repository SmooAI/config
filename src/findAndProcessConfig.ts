/* eslint-disable @typescript-eslint/no-explicit-any -- ok */
import { any as findAny} from 'empathic/find';
import { stat } from 'fs/promises';
import TTLCache from '@isaacs/ttlcache';
import { join } from 'path';
import { glob } from 'glob';
import { getCloudRegion } from './getCloudRegion';
import Logger from '@smooai/logger/Logger';
import { directoryExists, initEsmUtils, importFile, SmooaiConfigError, envToUse } from './utils';
import { mergeReplaceArrays } from './utils/mergeReplaceArrays';
import { z } from 'zod';
import { access } from 'fs/promises';
import { constants } from 'fs';
import { PublicConfigKey } from './PublicConfigKey';
import { StandardSchemaV1 } from '@standard-schema/spec';
import { defineConfig, ParsedConfigGeneric } from './config';
initEsmUtils();

const logger = new Logger({
    name: global.__filename,
});

const ENV_CONFIG_DIR_CACHE = new TTLCache<string, string>({ max: 1, ttl: 1000 * 60 * 60 });

/**
 * Find the directory where the config files are located.
 *
 * Config files are located depending on the following logic:
 * 1. If the "SMOOAI_ENV_CONFIG_DIR" environment variable is set, the directory is the value of the variable.
 * 2. If the "SMOOAI_ENV_CONFIG_DIR" environment variable is not set, the directory is the first directory in the following list that exists <CWD> = Current Working Directory:
 *   a. <CWD>/.smooai-config
 *   b. <CWD>/smooai-config
 * 3. If these directories are not found, search up directory tree a maximum of 5 levels for the directories in step 2.
 *
 * @returns The directory where the config files are located.
 */
export async function findConfigDirectory(
    {
        ignoreCache,
    }: {
        ignoreCache?: boolean;
    } = {
        ignoreCache: false,
    },
): Promise<string> {
    ignoreCache = ignoreCache ?? false;

    const configDir = envToUse().SMOOAI_ENV_CONFIG_DIR;
    if (configDir) {
        if (await directoryExists(configDir)) {
            return configDir;
        } else {
            throw new SmooaiConfigError(`The directory specified in the "SMOOAI_ENV_CONFIG_DIR" environment variable does not exist: ${configDir}`);
        }
    }

    if (!ignoreCache) {
        const cachedConfigDir = ENV_CONFIG_DIR_CACHE.get('smooai-config');
        if (cachedConfigDir) {
            if (await directoryExists(cachedConfigDir)) {
                return cachedConfigDir;
            } else {
                ENV_CONFIG_DIR_CACHE.delete('smooai-config');
            }
        }
    }

    const configDirCandidates = ['.smooai-config', 'smooai-config'];

    const cwd = process.cwd();
    const configDirCandidatePaths = configDirCandidates.map((dir) => join(cwd, dir));

    const candidateResults = await Promise.allSettled(
        configDirCandidatePaths.map(async (dirPath) => [await directoryExists(dirPath), dirPath] as [boolean, string]),
    );

    for (const candidate of candidateResults) {
        if (candidate.status === 'fulfilled' && candidate.value[0]) {
            ENV_CONFIG_DIR_CACHE.set('smooai-config', candidate.value[1]);
            return candidate.value[1];
        }
    }

    const levelsUpLimit = parseInt(envToUse().SMOOAI_CONFIG_LEVELS_UP_LIMIT ?? '5', 10) || 5;

    const upDirFound = await findAny(configDirCandidates, {
        cwd,
        stop: join(cwd, ...Array(levelsUpLimit).fill('..')),
    });

    if (upDirFound) {
        if (!(await directoryExists(upDirFound))) {
            throw new SmooaiConfigError(`The directory specified in the "SMOOAI_ENV_CONFIG_DIR" environment variable is not a directory: ${configDir}`);
        }
        ENV_CONFIG_DIR_CACHE.set('smooai-config', upDirFound);
        return upDirFound;
    }

    throw new SmooaiConfigError(`Could not find the directory where the config files are located. Tried ${levelsUpLimit} levels up from ${cwd}.`);
}

/**
 * Checks the two prerequisites for the config files and returns the config values schema.
 * 
 * Prerequisites:
 * 1. The config directory must contain a `default.ts` file that exports a default config object of the type `ConfigType`.
 * 2. The config directory must contain a `config.ts` file that exports a default result of `defineConfig`.
 * 
 * @param configDir - The directory where the config files are located.
 * @returns The config values schema.
 */
async function checkPrerequisitesAndGetConfigSchema(configDir: string): Promise<ReturnType<typeof defineConfig>> {
    const configSchema = await importFile(join(configDir, 'config.ts'), `Missing required config values schema file (config.ts) in config directory: ${configDir}`);

    if (!configSchema.default || !configSchema.default.parseConfig) {
        throw new SmooaiConfigError('The config.ts file must have a default export that is the result of `defineConfig`.');
    }

    try {
        await access(join(configDir, 'default.ts'), constants.R_OK);
    } catch (err) {
        throw new SmooaiConfigError(`Missing required default config file (default.ts) in config directory: ${configDir}`, { cause: err });
    }

    return configSchema.default;
}

async function processConfigFileFeatures(configSchema: ReturnType<typeof defineConfig>, currentConfig: any, config: ParsedConfigGeneric) {
    const finalConfig: Record<string, any> = {};
    
    for (const key in config) {
        const value = config[key];
        if (typeof value === 'function') {
            // We need to parse the value because it might be a function that returns a value that is not valid.
            config[key] = configSchema.parseConfigKey(key, value(currentConfig));
            finalConfig[key] = config[key];
        } else {
            config[key] = value;
            finalConfig[key] = value;
        }
    }

    return finalConfig;
}
function setBuiltInConfig(config: Record<string, any>, {
    env,
    region,
    provider,
    isLocal,
}: {
    env: string;
    region: string;
    provider: string;
    isLocal: boolean;
}) {
    config[PublicConfigKey.ENV] = env;
    config[PublicConfigKey.REGION] = region;
    config[PublicConfigKey.CLOUD_PROVIDER] = provider;
    config[PublicConfigKey.IS_LOCAL] = isLocal;

    return config;
}


/**
 * Find and process the config files in the found directory.
 *
 * Order of merges:
 * 1. Load `default.ts` (required).
 * 2. Load `local.ts` if `IS_LOCAL === "true"`.
 * 3. If `SMOOAI_CONFIG_ENV` is set to e.g. "development":
 *    a) `development.ts`
 *    b) `development.{provider}.ts`
 *    c) `development.{provider}.{region}.ts`
 *
 * Returns the merged config object.
 */
export async function findAndProcessConfig(): Promise<Record<string, any>> {
    let finalConfig: Record<string, any> = {};
    try {
        const configDir = await findConfigDirectory();

        const isLocal = Boolean(envToUse().IS_LOCAL);
        const env = envToUse().SMOOAI_CONFIG_ENV ?? 'development';
        const { provider, region } = await getCloudRegion();

        const configSchema = await checkPrerequisitesAndGetConfigSchema(configDir);

        // We define the possible config files in the order to load them.
        const configFiles: string[] = ['default.ts']; // required
        if (isLocal) {
            configFiles.push('local.ts');
        }
        if (env) {
            configFiles.push(`${env}.ts`);
            if (provider) {
                configFiles.push(`${env}.${provider}.ts`);
                if (region) {
                    configFiles.push(`${env}.${provider}.${region}.ts`);
                }
            }
        }

        // The final merged config

        // Go through each possible file in order, see if it exists, merge
        for (const fileName of configFiles) {
            const matchedPaths = await glob(fileName, {
                cwd: configDir,
                absolute: true,
            });

            // If default.ts not found, throw an error
            if (fileName === 'default.ts' && matchedPaths.length === 0) {
                const error = new Error(`Could not find required default config file in ${configDir}: "${fileName}"`);
                logger.error(error, `Could not find required default config file in ${configDir}: "${fileName}"`);
                throw error;
            }

            for (const filePath of matchedPaths) {
                try {
                    // Attempt to import. If `export default` is used, use that, else use entire import.
                    const configModule = await configSchema.parseConfig(await importFile(filePath));
                    const processedConfig = await processConfigFileFeatures(configSchema, finalConfig, configModule);
                    finalConfig = mergeReplaceArrays(finalConfig, processedConfig);
                } catch (err) {
                    logger.error(`Error importing config file "${filePath}":`, err);
                    throw err;
                }
            }
        }

        finalConfig = setBuiltInConfig(finalConfig, {
            env,
            region,
            provider,
            isLocal,
        });
    } catch (err) {
        logger.error('Error finding and processing config:', err);
        throw err;
    }

    return finalConfig;
}
