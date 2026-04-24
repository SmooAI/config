import { describe, it, expect } from 'vitest';
import { resolveSchemaName } from './push';

describe('resolveSchemaName (SMOODEV-643)', () => {
    it('prefers the --schema-name flag', () => {
        expect(resolveSchemaName('flag-name', undefined)).toEqual({ schemaName: 'flag-name', source: 'flag' });
    });

    it('falls back to the config file declaration', () => {
        expect(resolveSchemaName(undefined, 'file-name')).toEqual({ schemaName: 'file-name', source: 'config' });
    });

    it('warns when flag and file disagree but prefers the flag (explicit intent)', () => {
        const result = resolveSchemaName('flag-name', 'file-name');
        expect(result.schemaName).toBe('flag-name');
        expect(result.source).toBe('flag');
        expect(result.warning).toMatch(/overrides/i);
    });

    it('does not warn when flag and file match', () => {
        const result = resolveSchemaName('same-name', 'same-name');
        expect(result.warning).toBeUndefined();
    });

    it('throws a helpful error when neither is present (no more cwd basename fallback)', () => {
        expect(() => resolveSchemaName(undefined, undefined)).toThrow(/Schema name is required/);
    });
});
