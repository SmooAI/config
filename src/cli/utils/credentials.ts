/**
 * Manage CLI credentials stored at ~/.smooai/credentials.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface Credentials {
    apiKey: string;
    orgId: string;
    baseUrl: string;
}

const SMOOAI_DIR = join(homedir(), '.smooai');
const CREDENTIALS_FILE = join(SMOOAI_DIR, 'credentials.json');

export function loadCredentials(): Credentials | null {
    try {
        if (!existsSync(CREDENTIALS_FILE)) return null;
        const raw = readFileSync(CREDENTIALS_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed.apiKey || !parsed.orgId || !parsed.baseUrl) return null;
        return parsed as Credentials;
    } catch {
        return null;
    }
}

export function saveCredentials(credentials: Credentials): void {
    mkdirSync(SMOOAI_DIR, { recursive: true });
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
