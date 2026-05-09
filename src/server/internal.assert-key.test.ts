/**
 * Unit tests for `assertKeyDefined` — the guard that fronts every server-side
 * `get()` / `getSync()` so callers don't fall into envVarNameFor's
 * `undefined.replace(...)` cascade when they pass a key that isn't declared
 * in the schema (SMOODEV-841 / SMOODEV-847).
 */
import { BooleanSchema, defineConfig, StringSchema } from '@/config/config';
import { describe, expect, it } from 'vitest';
import { assertKeyDefined, buildConfigAsync } from './internal';

describe('assertKeyDefined', () => {
    it('passes for non-empty strings', () => {
        expect(() => assertKeyDefined('apiUrl', 'public')).not.toThrow();
        expect(() => assertKeyDefined('myKey', 'secret')).not.toThrow();
        expect(() => assertKeyDefined('flagName', 'featureFlag')).not.toThrow();
    });

    it('throws a clear error for undefined', () => {
        expect(() => assertKeyDefined(undefined, 'secret')).toThrow(/SecretConfigKeys/);
        expect(() => assertKeyDefined(undefined, 'secret')).toThrow(/undefined/);
        expect(() => assertKeyDefined(undefined, 'public')).toThrow(/PublicConfigKeys/);
        expect(() => assertKeyDefined(undefined, 'featureFlag')).toThrow(/FeatureFlagKeys/);
    });

    it('throws for null', () => {
        expect(() => assertKeyDefined(null, 'secret')).toThrow(/null/);
    });

    it('throws for non-strings', () => {
        expect(() => assertKeyDefined(42, 'secret')).toThrow(/non-string/);
        expect(() => assertKeyDefined({}, 'public')).toThrow(/non-string/);
    });

    it('throws for empty string', () => {
        expect(() => assertKeyDefined('', 'secret')).toThrow();
    });

    it('mentions the schema-declaration fix in the message', () => {
        expect(() => assertKeyDefined(undefined, 'secret')).toThrow(/declared in your schema/);
        expect(() => assertKeyDefined(undefined, 'secret')).toThrow(/smooai-config push/);
    });
});

describe('build*Config get() guards against undefined key', () => {
    const schema = defineConfig({
        publicConfigSchema: { apiUrl: StringSchema },
        secretConfigSchema: { sendgridApiKey: StringSchema },
        featureFlagSchema: { observability: BooleanSchema },
    });

    it('secretConfig.get(undefined) throws clear error (was: cryptic .replace crash)', async () => {
        const cfg = buildConfigAsync(schema);
        await expect(cfg.secretConfig.get(undefined as unknown as 'sendgridApiKey')).rejects.toThrow(/SecretConfigKeys/);
        await expect(cfg.secretConfig.get(undefined as unknown as 'sendgridApiKey')).rejects.not.toThrow(
            /Cannot read properties of undefined \(reading 'replace'\)/,
        );
    });

    it('publicConfig.get(undefined) throws clear error', async () => {
        const cfg = buildConfigAsync(schema);
        await expect(cfg.publicConfig.get(undefined as unknown as 'apiUrl')).rejects.toThrow(/PublicConfigKeys/);
    });

    it('featureFlag.get(undefined) throws clear error', async () => {
        const cfg = buildConfigAsync(schema);
        await expect(cfg.featureFlag.get(undefined as unknown as 'observability')).rejects.toThrow(/FeatureFlagKeys/);
    });
});
