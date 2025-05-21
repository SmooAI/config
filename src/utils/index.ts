/* eslint-disable @typescript-eslint/no-explicit-any -- ok */
import createEsmUtils from 'esm-utils';

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

/**
 * Minimal utility to detect an object (excludes arrays).
 */
export function isPlainObject(obj: unknown): obj is Record<string, unknown> {
    return !!obj && typeof obj === 'object' && !Array.isArray(obj);
}

export class SmooaiConfigError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(`[Smooai Config] ${message}`, options);
    }
}

// ——— helper: single-char step, always recursing into SnakeCase<> ———
type _SnakeCaseChar<S extends string> = S extends `${infer First}${infer Rest}`
    ? First extends '_' | ' '
        ? SnakeCase<Rest> // drop "_" or " "
        : Rest extends Uncapitalize<Rest>
          ? `${Lowercase<First>}${SnakeCase<Rest>}` // next is lower/non-letter → no underscore
          : First extends Lowercase<First>
            ? `${Lowercase<First>}_${SnakeCase<Rest>}` // lower→upper → underscore
            : `${Lowercase<First>}${SnakeCase<Rest>}` // upper→upper → no underscore
    : S; // empty or single character

// ——— your public SnakeCase<> with 3-char look-ahead for acronyms ———
export type SnakeCase<S extends string> =
    // 1⃣ Acronym boundary: Upper + Upper + lower  (e.g. "IKey" → "i_key")
    S extends `${infer A}${infer B}${infer C}${infer Rest}`
        ? A extends Uppercase<A>
            ? B extends Uppercase<B>
                ? C extends Lowercase<C>
                    ? `${Lowercase<A>}_${SnakeCase<`${B}${C}${Rest}`>}`
                    : _SnakeCaseChar<S>
                : _SnakeCaseChar<S>
            : _SnakeCaseChar<S>
        : // 2⃣ If we don’t even have 3 chars to peek, fall back to the single-char step
          _SnakeCaseChar<S>;

export type UpperSnakeCase<S extends string> =
    S extends Uppercase<S>
        ? S extends `${string} ${string}`
            ? // if it had a space, rerun SnakeCase to turn that into " "
              Uppercase<SnakeCase<S>>
            : S
        : Uppercase<SnakeCase<S>>;

export type UnionToUpperSnake<U> = U extends string ? UpperSnakeCase<U> : never;

/**
 * One-pass, no-regex UPPER_SNAKE_CASE converter.
 * - Early exit if already UPPER_SNAKE_CASE.
 * - Drops spaces/underscores.
 * - Splits on  lower→Upper  and  Acronym→Word
 */
export function snakecase(input: string): string {
    // Early return if it’s already UPPER_SNAKE_CASE
    if (/^[A-Z0-9]+(?:_[A-Z0-9]+)*$/.test(input)) {
        return input;
    }

    let out = '';
    const len = input.length;

    for (let i = 0; i < len; i++) {
        const ch = input[i];
        if (ch === '_' || ch === ' ') continue; // drop underscores/spaces

        const code = input.charCodeAt(i);
        const isUpper = code >= 65 && code <= 90; // A–Z
        const isLower = code >= 97 && code <= 122; // a–z
        const isDigit = code >= 48 && code <= 57; // 0–9

        if (isUpper) {
            // split on lower→upper or acronym→word
            if (i > 0) {
                const prev = input.charCodeAt(i - 1);
                const prevIsLower = prev >= 97 && prev <= 122;
                const next = i + 1 < len ? input.charCodeAt(i + 1) : NaN;
                const nextIsLower = next >= 97 && next <= 122;
                if (prevIsLower || nextIsLower) {
                    out += '_';
                }
            }
            out += ch; // keep uppercase
        } else if (isLower) {
            // lowercase → uppercase
            out += String.fromCharCode(code - 32);
        } else if (isDigit) {
            // digit → append as-is
            out += ch;
        } else {
            // any other character: append or drop as you see fit
            out += ch;
        }
    }

    return out;
}

export function convertKeyToUpperSnakeCase(key: string): string {
    return snakecase(key).toUpperCase();
}
