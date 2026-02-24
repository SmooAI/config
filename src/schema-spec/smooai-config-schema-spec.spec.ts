import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { validateSmooaiSchema } from './smooai-config-schema-spec';

interface ValidCase {
    name: string;
    schema: Record<string, unknown>;
}

interface InvalidCase {
    name: string;
    schema: Record<string, unknown>;
    expected_keywords: string[];
}

interface TestFixtures {
    valid: ValidCase[];
    invalid: InvalidCase[];
}

const fixtures: TestFixtures = JSON.parse(readFileSync(join(__dirname, '../../test-fixtures/schema-validation-cases.json'), 'utf-8'));

describe('validateSmooaiSchema', () => {
    describe('valid schemas', () => {
        for (const testCase of fixtures.valid) {
            it(`accepts: ${testCase.name}`, () => {
                const result = validateSmooaiSchema(testCase.schema);
                expect(result.valid).toBe(true);
                expect(result.errors).toHaveLength(0);
            });
        }
    });

    describe('invalid schemas', () => {
        for (const testCase of fixtures.invalid) {
            it(`rejects: ${testCase.name}`, () => {
                const result = validateSmooaiSchema(testCase.schema);
                expect(result.valid).toBe(false);
                expect(result.errors.length).toBeGreaterThan(0);

                // Each expected keyword should appear in at least one error
                for (const expectedKeyword of testCase.expected_keywords) {
                    const found = result.errors.some((e) => e.keyword === expectedKeyword);
                    expect(found, `Expected error for keyword "${expectedKeyword}" in test "${testCase.name}"`).toBe(true);
                }
            });
        }
    });

    describe('error structure', () => {
        it('returns path, keyword, message, and suggestion for each error', () => {
            const schema = {
                type: 'object',
                properties: {
                    value: { not: { type: 'string' } },
                },
            };
            const result = validateSmooaiSchema(schema);
            expect(result.valid).toBe(false);
            expect(result.errors).toHaveLength(1);
            const error = result.errors[0];
            expect(error.path).toBe('/properties/value');
            expect(error.keyword).toBe('not');
            expect(error.message).toContain('not');
            expect(error.suggestion).toBeTruthy();
        });

        it('reports unsupported format values', () => {
            const schema = {
                type: 'object',
                properties: {
                    field: { type: 'string', format: 'hostname' },
                },
            };
            const result = validateSmooaiSchema(schema);
            expect(result.valid).toBe(false);
            expect(result.errors[0].keyword).toBe('format');
            expect(result.errors[0].message).toContain('hostname');
        });

        it('accepts supported format values', () => {
            const schema = {
                type: 'object',
                properties: {
                    email: { type: 'string', format: 'email' },
                    uri: { type: 'string', format: 'uri' },
                },
            };
            const result = validateSmooaiSchema(schema);
            expect(result.valid).toBe(true);
        });
    });

    describe('nested detection', () => {
        it('catches unsupported keywords in deeply nested schemas', () => {
            const schema = {
                type: 'object',
                properties: {
                    level1: {
                        type: 'object',
                        properties: {
                            level2: {
                                type: 'object',
                                patternProperties: { '^x-': { type: 'string' } },
                            },
                        },
                    },
                },
            };
            const result = validateSmooaiSchema(schema);
            expect(result.valid).toBe(false);
            expect(result.errors[0].path).toBe('/properties/level1/properties/level2');
        });

        it('catches unsupported keywords inside anyOf variants', () => {
            const schema = {
                type: 'object',
                properties: {
                    value: {
                        anyOf: [{ type: 'string' }, { type: 'object', patternProperties: { '^x-': { type: 'string' } } }],
                    },
                },
            };
            const result = validateSmooaiSchema(schema);
            expect(result.valid).toBe(false);
            expect(result.errors[0].path).toContain('anyOf/1');
        });

        it('catches unsupported keywords inside $defs', () => {
            const schema = {
                type: 'object',
                $defs: {
                    BadDef: {
                        type: 'object',
                        dependencies: { a: ['b'] },
                    },
                },
                properties: {},
            };
            const result = validateSmooaiSchema(schema);
            expect(result.valid).toBe(false);
            expect(result.errors[0].path).toContain('$defs/BadDef');
        });
    });

    it('handles empty schema', () => {
        const result = validateSmooaiSchema({});
        expect(result.valid).toBe(true);
    });

    it('handles schema with only metadata', () => {
        const result = validateSmooaiSchema({
            $schema: 'http://json-schema.org/draft-07/schema#',
            title: 'Test',
            description: 'A test schema',
        });
        expect(result.valid).toBe(true);
    });
});
