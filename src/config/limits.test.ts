import { describe, it, expect } from 'vitest';
import { clampLimit, defineConfig, defineLimit, LimitDefinition } from './config';

describe('defineLimit', () => {
    it('produces a tagged LimitDefinition with the clamp metadata', () => {
        const def = defineLimit({ default: 12, min: 1, max: 50, step: 2 });
        expect(def).toEqual({ __smooLimit: true, default: 12, min: 1, max: 50, step: 2 });
    });

    it('allows a bare default with no bounds', () => {
        expect(defineLimit({ default: 5 })).toEqual({ __smooLimit: true, default: 5, min: undefined, max: undefined, step: undefined });
    });

    it('rejects a non-finite default', () => {
        expect(() => defineLimit({ default: Number.NaN })).toThrow(/finite number/);
        expect(() => defineLimit({ default: Infinity })).toThrow(/finite number/);
    });

    it('rejects min > max', () => {
        expect(() => defineLimit({ default: 5, min: 10, max: 1 })).toThrow(/must be <=/);
    });

    it('rejects a default outside [min, max]', () => {
        expect(() => defineLimit({ default: 0, min: 1, max: 50 })).toThrow(/>= `min`/);
        expect(() => defineLimit({ default: 99, min: 1, max: 50 })).toThrow(/<= `max`/);
    });

    it('rejects a non-positive step', () => {
        expect(() => defineLimit({ default: 5, step: 0 })).toThrow(/positive number/);
        expect(() => defineLimit({ default: 5, step: -1 })).toThrow(/positive number/);
    });
});

describe('clampLimit', () => {
    const def: LimitDefinition = { __smooLimit: true, default: 12, min: 1, max: 50 };

    it('returns in-range values unchanged', () => {
        expect(clampLimit(20, def)).toBe(20);
    });

    it('clamps below min and above max', () => {
        expect(clampLimit(-5, def)).toBe(1);
        expect(clampLimit(1000, def)).toBe(50);
    });

    it('falls back to default for non-numeric / non-finite input', () => {
        expect(clampLimit(undefined, def)).toBe(12);
        expect(clampLimit(null, def)).toBe(12);
        expect(clampLimit('not a number', def)).toBe(12);
        expect(clampLimit(Number.NaN, def)).toBe(12);
    });

    it('coerces numeric strings', () => {
        expect(clampLimit('30', def)).toBe(30);
        expect(clampLimit('999', def)).toBe(50);
    });

    it('snaps to step before clamping', () => {
        const stepped: LimitDefinition = { __smooLimit: true, default: 10, min: 0, max: 100, step: 5 };
        expect(clampLimit(12, stepped)).toBe(10);
        expect(clampLimit(13, stepped)).toBe(15);
    });

    it('works with only a default (no bounds)', () => {
        const open: LimitDefinition = { __smooLimit: true, default: 7 };
        expect(clampLimit(1000, open)).toBe(1000);
        expect(clampLimit('x', open)).toBe(7);
    });
});

describe('defineConfig with limitsSchema', () => {
    const config = defineConfig({
        limitsSchema: {
            agentMaxIterations: defineLimit({ default: 12, min: 1, max: 50 }),
            maxTokens: defineLimit({ default: 4096, step: 256 }),
        },
    });

    it('exposes UPPER_SNAKE LimitKeys', () => {
        expect(config.LimitKeys).toEqual({
            AGENT_MAX_ITERATIONS: 'agentMaxIterations',
            MAX_TOKENS: 'maxTokens',
        });
    });

    it('carries the clamp metadata on _limitsMeta', () => {
        expect(config._limitsMeta.agentMaxIterations).toEqual({ __smooLimit: true, default: 12, min: 1, max: 50, step: undefined });
    });

    it('serializes limits as bounded number JSON Schema nodes', () => {
        const props = (config.serializedAllConfigSchemaJsonSchema as any).properties.limitsSchema.properties;
        expect(props.agentMaxIterations).toEqual({ type: 'number', default: 12, minimum: 1, maximum: 50 });
        expect(props.maxTokens).toEqual({ type: 'number', default: 4096, multipleOf: 256 });
    });

    it('keeps all four tier nodes in the serialized schema', () => {
        const props = (config.serializedAllConfigSchemaJsonSchema as any).properties;
        expect(props.publicConfigSchema).toBeDefined();
        expect(props.secretConfigSchema).toBeDefined();
        expect(props.featureFlagSchema).toBeDefined();
        expect(props.limitsSchema).toBeDefined();
    });
});
