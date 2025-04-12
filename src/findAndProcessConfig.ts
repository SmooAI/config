/* eslint-disable @typescript-eslint/no-explicit-any -- ok */
import { findUpMultiple } from 'find-up';
import TTLCache from '@isaacs/ttlcache';
import { join } from 'path';
import { glob } from 'glob';
import { getCloudRegion } from './getCloudRegion';
import Logger from '@smooai/logger/Logger';
import { directoryExists, initEsmUtils, importFile, SmooaiConfigError } from './utils';
import { mergeReplaceArrays } from './utils/mergeReplaceArrays';
import { z } from 'zod';
import { access } from 'fs/promises';
import { constants } from 'fs';
import { PublicConfigKey } from './PublicConfigKey';
import { StandardSchemaV1 } from '@standard-schema/spec';
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

    const configDir = process.env.SMOOAI_ENV_CONFIG_DIR;
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

    const upDirCandidates = await findUpMultiple(configDirCandidates, {
        type: 'directory',
        stopAt: join(cwd, '..', '..', '..', '..', '..'),
    });

    if (upDirCandidates?.length ?? 0 > 0) {
        ENV_CONFIG_DIR_CACHE.set('smooai-config', upDirCandidates[0]);
        return upDirCandidates[0];
    }

    throw new SmooaiConfigError('Could not find the directory where the config files are located.');
}

/**
 * Checks the two prerequisites for the config files and returns the config values schema.
 * 
 * Prerequisites:
 * 1. The config directory must contain a `default.ts` file.
 * 2. The config directory must contain a `schema.ts` file that exports the `ConfigValues` schema.
 * 
 * @param configDir - The directory where the config files are located.
 * @returns The config values schema.
 */
async function checkPrerequisitesAndGetConfigValuesSchema(configDir: string): Promise<z.AnyZodObject> {
    const configValuesSchema = await importFile(join(configDir, 'schema.ts'), `Missing required config values schema file (schema.ts) in config directory: ${configDir}`);

    if (!configValuesSchema.ConfigValues) {
        throw new SmooaiConfigError('The config values schema file must export "ConfigValues".');
    }

    try {
        await access(join(configDir, 'default.ts'), constants.R_OK);
    } catch (err) {
        throw new SmooaiConfigError(`Missing required default config file (default.ts) in config directory: ${configDir}`, { cause: err });
    }

    return configValuesSchema.ConfigValues;
}

async function processConfigFileFeatures(currentConfig: any, config: Record<string, 
    string |
    ((obj: any) => string | any) |
    {
        _schema: StandardSchemaV1,
        value: any
    } |
    any
>) {
    for (const key in config) {
        const value = config[key];
        if (typeof value === 'function') {
            config[key] = value(currentConfig);
        } else if ('_schema' in value) {
            config[key] = await value._schema['~standard'].validate(value.value);
        } else {
            config[key] = value;
        }
    }
}
function setBuiltInConfigValues(config: Record<string, any>, {
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

        const isLocal = Boolean(process.env.IS_LOCAL);
        const env = process.env.SMOOAI_CONFIG_ENV ?? 'development';
        const { provider, region } = await getCloudRegion();

        const configValuesSchema = await checkPrerequisitesAndGetConfigValuesSchema(configDir);

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
                    const configModule = await configValuesSchema.parseAsync(await importFile(filePath));
                    const processedConfig = await processConfigFileFeatures(finalConfig, configModule);
                    finalConfig = mergeReplaceArrays(finalConfig, processedConfig);
                } catch (err) {
                    logger.error(`Error importing config file "${filePath}":`, err);
                    throw err;
                }
            }
        }

        finalConfig = setBuiltInConfigValues(finalConfig, {
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
