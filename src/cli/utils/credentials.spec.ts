import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Test with a temp dir inside the real homedir to avoid mock complexity
const testSmooaiDir = join(homedir(), '.smooai-test-cli');
const testCredFile = join(testSmooaiDir, 'credentials.json');

// Override the module's constants by providing a wrapper
// Since we can't easily mock the module's internal constants,
// we test the core logic patterns directly

describe('credentials logic', () => {
    beforeAll(() => {
        mkdirSync(testSmooaiDir, { recursive: true });
    });

    afterAll(() => {
        try {
            rmSync(testSmooaiDir, { recursive: true });
        } catch {
            // ignore
        }
    });

    describe('credential file read/write', () => {
        it('round-trips credentials through JSON', () => {
            const creds = { apiKey: 'test-key', orgId: 'test-org', baseUrl: 'https://api.test.com' };
            writeFileSync(testCredFile, JSON.stringify(creds, null, 2), { mode: 0o600 });

            const raw = readFileSync(testCredFile, 'utf-8');
            const parsed = JSON.parse(raw);
            expect(parsed).toEqual(creds);
        });

        it('detects missing required fields', () => {
            writeFileSync(testCredFile, JSON.stringify({ apiKey: 'only-key' }));
            const parsed = JSON.parse(readFileSync(testCredFile, 'utf-8'));
            expect(!parsed.apiKey || !parsed.orgId || !parsed.baseUrl).toBe(true);
        });

        it('handles missing file gracefully', () => {
            const nonExistent = join(testSmooaiDir, 'nonexistent.json');
            expect(existsSync(nonExistent)).toBe(false);
        });

        it('handles invalid JSON gracefully', () => {
            writeFileSync(testCredFile, 'not valid json');
            expect(() => JSON.parse(readFileSync(testCredFile, 'utf-8'))).toThrow();
        });
    });

    describe('loadCredentials integration', () => {
        it('loads and saves from the real module', async () => {
            // Import the real module
            const { loadCredentials, saveCredentials } = await import('./credentials');

            // Save real credentials
            const creds = { apiKey: 'integration-key', orgId: 'integration-org', baseUrl: 'https://api.integration.com' };
            saveCredentials(creds);

            // Load them back
            const loaded = loadCredentials();
            expect(loaded).toEqual(creds);
        });
    });
});
