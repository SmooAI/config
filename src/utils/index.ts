/* eslint-disable @typescript-eslint/no-explicit-any -- ok */
import { stat, access } from "fs/promises";
import createEsmUtils from 'esm-utils';
import { constants } from 'fs';

/**
 * Initialize global __dirname and __filename if not already set.
 */
export function initEsmUtils() {
    if (!global.__dirname || !global.__filename) {
        const { __dirname, __filename } = import.meta.url
            ? createEsmUtils({ url: import.meta.url, resolve: import.meta.resolve } as any)
            : { __dirname: '', __filename: '' };
        global.__dirname = global.__dirname ? global.__dirname : __dirname;
        global.__filename = global.__filename ? global.__filename : __filename;
    }
}

/**
 * Check if an object is empty.
 */
function isEmpty(obj: any): boolean {
    for (const prop in obj) {
        if (Object.hasOwn(obj, prop)) {
            return false;
        }
    }
    return true;
}

/**
 * Get the environment variables. Works in Node and Various React Runtimes.
 */
export const envToUse = (): NodeJS.ProcessEnv => (!isEmpty(process?.env) ? process.env : (import.meta as unknown as { env: NodeJS.ProcessEnv }).env);

export async function directoryExists(path: string): Promise<boolean> {
    try {
        const stats = await stat(path);
        return stats.isDirectory();
    } catch {
        return false;
    }
}

/**
 * Minimal utility to detect an object (excludes arrays).
 */
export function isPlainObject(obj: unknown): obj is Record<string, unknown> {
    return !!obj && typeof obj === 'object' && !Array.isArray(obj);
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
    return imported.default ?? imported;
}

export class SmooaiConfigError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(`[Smooai Config] ${message}`, options);
    }
}