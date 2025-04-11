import { stat } from 'fs/promises';
import { findUpMultiple } from 'find-up';
import { LRUCache } from 'lru-cache';
import { join } from 'path';
import { glob } from 'glob';
import { getCloudRegion } from './getCloudRegion';
import Logger from '@smooai/logger/Logger';

const logger = new Logger({
    name: 'smooai:new-config:envConfig:findAndProcessEnvConfig',
});

const ENV_CONFIG_DIR_CACHE = new LRUCache<string, string>({ max: 1, ttl: 1000 * 60 * 60 });

export async function directoryExists(path: string): Promise<boolean> {
    try {
        const stats = await stat(path);
        return stats.isDirectory();
    } catch {
        return false;
    }
}

/**
 * Find the directory where the env config files are located.
 *
 * Env config files are located depending on the following logic:
 * 1. If the "SMOOAI_ENV_CONFIG_DIR" environment variable is set, the directory is the value of the variable.
 * 2. If the "SMOOAI_ENV_CONFIG_DIR" environment variable is not set, the directory is the first directory in the following list that exists <CWD> = Current Working Directory:
 *   a. <CWD>/.smooai-env-config
 *   b. <CWD>/smooai-env-config
 * 3. If these directories are not found, search up directory tree a maximum of 5 levels for the directories in step 2.
 *
 * @returns The directory where the env config files are located.
 */
export async function findEnvConfigDirectory(
    {
        ignoreCache,
    }: {
        ignoreCache?: boolean;
    } = {
        ignoreCache: false,
    },
): Promise<string> {
    ignoreCache = ignoreCache ?? false;

    const envConfigDir = process.env.SMOOAI_ENV_CONFIG_DIR;
    if (envConfigDir) {
        if (await directoryExists(envConfigDir)) {
            return envConfigDir;
        } else {
            throw new Error(`The directory specified in the "SMOOAI_ENV_CONFIG_DIR" environment variable does not exist: ${envConfigDir}`);
        }
    }

    if (!ignoreCache) {
        const cachedEnvConfigDir = ENV_CONFIG_DIR_CACHE.get('smooai-env-config');
        if (cachedEnvConfigDir) {
            if (await directoryExists(cachedEnvConfigDir)) {
                return cachedEnvConfigDir;
            } else {
                ENV_CONFIG_DIR_CACHE.delete('smooai-env-config');
            }
        }
    }

    const envConfigDirCandidates = ['.smooai-env-config', 'smooai-env-config'];

    const cwd = process.cwd();
    const envConfigDirCandidatePaths = envConfigDirCandidates.map((dir) => join(cwd, dir));

    const candidateResults = await Promise.allSettled(
        envConfigDirCandidatePaths.map(async (dirPath) => [await directoryExists(dirPath), dirPath] as [boolean, string]),
    );

    for (const candidate of candidateResults) {
        if (candidate.status === 'fulfilled' && candidate.value[0]) {
            ENV_CONFIG_DIR_CACHE.set('smooai-env-config', candidate.value[1]);
            return candidate.value[1];
        }
    }

    const upDirCandidates = await findUpMultiple(envConfigDirCandidates, {
        type: 'directory',
        stopAt: join(cwd, '..', '..', '..', '..', '..'),
    });

    if (upDirCandidates?.length ?? 0 > 0) {
        ENV_CONFIG_DIR_CACHE.set('smooai-env-config', upDirCandidates[0]);
        return upDirCandidates[0];
    }

    throw new Error('Could not find the directory where the env config files are located.');
}

/**
 * Minimal utility to detect an object (excludes arrays).
 */
function isPlainObject(obj: unknown): obj is Record<string, unknown> {
    return !!obj && typeof obj === 'object' && !Array.isArray(obj);
}

/**
 * A custom merge that:
 * - Recursively merges child objects.
 * - **Replaces** arrays instead of concatenating.
 * - Overwrites scalars directly.
 */
function mergeReplaceArrays(target: any, source: any): any {
    // If source is an array, replace entirely.
    if (Array.isArray(source)) {
        return source.slice(); // new copy
    }

    // If source is an object, merge deeply.
    if (isPlainObject(source)) {
        // If target isn't an object, overwrite with a new object.
        if (!isPlainObject(target)) {
            target = {};
        }
        for (const key of Object.keys(source)) {
            target[key] = mergeReplaceArrays(target[key], source[key]);
        }
        return target;
    }

    // For primitives (string, number, etc.) or other data, overwrite.
    return source;
}

/**
 * Find and process the env config files in the found directory.
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
export async function findAndProcessEnvConfig(): Promise<Record<string, any>> {
    let finalConfig: Record<string, any> = {};
    try {
        const envConfigDir = await findEnvConfigDirectory();

        const isLocal = process.env.IS_LOCAL === 'true';
        const env = process.env.SMOOAI_CONFIG_ENV;
        const { provider, region } = await getCloudRegion();

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
                cwd: envConfigDir,
                absolute: true,
            });

            // If default.ts not found, throw an error
            if (fileName === 'default.ts' && matchedPaths.length === 0) {
                const error = new Error(`Could not find required default config file in ${envConfigDir}: "${fileName}"`);
                logger.error(error, `Could not find required default config file in ${envConfigDir}: "${fileName}"`);
                throw error;
            }

            for (const filePath of matchedPaths) {
                try {
                    // Attempt to import. If `export default` is used, use that, else use entire import.
                    const imported = await import(filePath);
                    const configModule = imported.default ?? imported;
                    finalConfig = mergeReplaceArrays(finalConfig, configModule);
                } catch (err) {
                    logger.error(`Error importing config file "${filePath}":`, err);
                    throw err;
                }
            }
        }
    } catch (err) {
        logger.error('Error finding and processing env config:', err);
        throw err;
    }

    return finalConfig;
}
