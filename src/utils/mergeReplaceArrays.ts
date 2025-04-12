import { isPlainObject } from './index';

/**
 * A custom merge that:
 * - Recursively merges child objects.
 * - **Replaces** arrays instead of concatenating.
 * - Overwrites scalars directly.
 */
export function mergeReplaceArrays(target: any, source: any): any {
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