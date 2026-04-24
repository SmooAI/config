/**
 * Manage CLI credentials stored at ~/.smooai/credentials.json.
 *
 * Supports two authentication modes:
 *   - OAuth2 client-credentials (preferred): clientId + clientSecret exchanged at
 *     auth.smoo.ai for a short-lived access token, auto-refreshed on expiry.
 *   - Legacy API key (fallback): apiKey used directly as `Authorization: Bearer`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface OAuthCredentials {
    clientId: string;
    clientSecret: string;
    orgId: string;
    baseUrl: string;
    authUrl: string;
    accessToken?: string;
    accessTokenExpiresAt?: number;
    /** Optional legacy fallback. */
    apiKey?: never;
}

export interface ApiKeyCredentials {
    apiKey: string;
    orgId: string;
    baseUrl: string;
    clientId?: never;
    clientSecret?: never;
    authUrl?: never;
    accessToken?: never;
    accessTokenExpiresAt?: never;
}

export type Credentials = OAuthCredentials | ApiKeyCredentials;

const SMOOAI_DIR = join(homedir(), '.smooai');
const CREDENTIALS_FILE = join(SMOOAI_DIR, 'credentials.json');

export function isOAuthCredentials(creds: Credentials): creds is OAuthCredentials {
    return typeof (creds as OAuthCredentials).clientId === 'string' && typeof (creds as OAuthCredentials).clientSecret === 'string';
}

/**
 * Substitute the leading hostname segment of `api.*` with `auth.*` to derive an
 * auth server URL. Falls back to unchanged input when the hostname doesn't
 * match the expected pattern.
 */
export function deriveAuthUrlFromBaseUrl(baseUrl: string): string {
    try {
        const url = new URL(baseUrl);
        if (url.hostname.startsWith('api.')) {
            url.hostname = `auth.${url.hostname.slice('api.'.length)}`;
        } else if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
            // Dev: keep as-is; tests will override explicitly.
            return baseUrl;
        }
        return url.toString().replace(/\/+$/, '');
    } catch {
        return baseUrl;
    }
}

export function loadCredentials(): Credentials | null {
    try {
        if (!existsSync(CREDENTIALS_FILE)) return null;
        const raw = readFileSync(CREDENTIALS_FILE, 'utf-8');
        const parsed = JSON.parse(raw);

        if (!parsed.orgId || !parsed.baseUrl) return null;

        // OAuth shape
        if (parsed.clientId && parsed.clientSecret) {
            return {
                clientId: parsed.clientId,
                clientSecret: parsed.clientSecret,
                orgId: parsed.orgId,
                baseUrl: parsed.baseUrl,
                authUrl: parsed.authUrl ?? deriveAuthUrlFromBaseUrl(parsed.baseUrl),
                accessToken: parsed.accessToken,
                accessTokenExpiresAt: parsed.accessTokenExpiresAt,
            };
        }

        // Legacy API key shape
        if (parsed.apiKey) {
            return { apiKey: parsed.apiKey, orgId: parsed.orgId, baseUrl: parsed.baseUrl };
        }

        return null;
    } catch {
        return null;
    }
}

export function saveCredentials(credentials: Credentials): void {
    mkdirSync(SMOOAI_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), { mode: 0o600 });
}

export function getCredentialsOrExit(): Credentials {
    const creds = loadCredentials();
    if (!creds) {
        console.error('Not logged in. Run `smooai-config login` first.');
        process.exit(1);
    }
    return creds;
}

/**
 * Mask a secret for display — show first 4 chars then fill with `•`.
 * Used for terminal output where recording might leak values.
 */
export function maskSecret(value: string): string {
    if (!value) return '';
    if (value.length <= 4) return '•'.repeat(8);
    const prefix = value.slice(0, 4);
    return `${prefix}${'•'.repeat(Math.min(value.length - 4, 16))}`;
}
