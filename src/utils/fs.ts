import { constants } from 'fs';
import { stat, access } from 'fs/promises';
import { SmooaiConfigError } from '.';

/**
 * Check if a directory exists.
 */
export async function directoryExists(path: string): Promise<boolean> {
    try {
        const stats = await stat(path);
        return stats.isDirectory();
    } catch {
        return false;
    }
}

/**
 * Import a file. - Used to help mock imports.
 */
export async function importFile(path: string, errorMessage?: string) {
    try {
        await access(path, constants.R_OK);
    } catch (e) {
        throw new SmooaiConfigError(errorMessage ?? `Unable to read file ${path}`, { cause: e });
    }
    const imported = await import(path);

    if (!imported.default) {
        throw new SmooaiConfigError(`The config file ${path} must have a default export.`);
    }

    return imported.default;
}
