import { describe, it, expect } from 'vitest';
import { validateJsonSchema, validateValue } from './schema-validator';

describe('schema-validator', () => {
    describe('validateJsonSchema', () => {
        it('validates a valid JSON Schema', () => {
            const schema = {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    age: { type: 'number' },
                },
            };
            expect(validateJsonSchema(schema)).toEqual({ valid: true });
        });

        it('rejects invalid JSON Schema', () => {
            const schema = {
                type: 'invalid-type',
            };
            const result = validateJsonSchema(schema);
            expect(result.valid).toBe(false);
            expect(result.errors).toBeDefined();
        });
    });

    describe('validateValue', () => {
        it('validates string value against stringSchema', () => {
            const schema = { apiKey: 'stringSchema' };
            expect(validateValue(schema, 'apiKey', 'hello')).toEqual({ valid: true });
        });

        it('rejects non-string value against stringSchema', () => {
            const schema = { apiKey: 'stringSchema' };
            const result = validateValue(schema, 'apiKey', 123);
            expect(result.valid).toBe(false);
        });

        it('validates boolean value against booleanSchema', () => {
            const schema = { debug: 'booleanSchema' };
            expect(validateValue(schema, 'debug', true)).toEqual({ valid: true });
            expect(validateValue(schema, 'debug', 'true')).toEqual({ valid: true });
        });

        it('validates number value against numberSchema', () => {
            const schema = { retries: 'numberSchema' };
            expect(validateValue(schema, 'retries', 5)).toEqual({ valid: true });
            expect(validateValue(schema, 'retries', '5')).toEqual({ valid: true });
        });

        it('rejects non-number value against numberSchema', () => {
            const schema = { retries: 'numberSchema' };
            const result = validateValue(schema, 'retries', 'abc');
            expect(result.valid).toBe(false);
        });

        it('validates against JSON Schema properties', () => {
            const schema = {
                properties: {
                    name: { type: 'string' },
                },
            };
            expect(validateValue(schema, 'name', 'hello')).toEqual({ valid: true });
        });

        it('rejects invalid value against JSON Schema properties', () => {
            const schema = {
                properties: {
                    name: { type: 'string' },
                },
            };
            const result = validateValue(schema, 'name', 123);
            expect(result.valid).toBe(false);
        });

        it('returns valid for unknown keys', () => {
            const schema = { apiKey: 'stringSchema' };
            expect(validateValue(schema, 'unknownKey', 'whatever')).toEqual({ valid: true });
        });
    });
});
