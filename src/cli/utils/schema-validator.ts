/**
 * Validate config values against JSON Schema using ajv.
 */

import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * Validate that a JSON Schema definition is well-formed.
 */
export function validateJsonSchema(schema: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    try {
        ajv.compile(schema);
        return { valid: true };
    } catch (err) {
        return {
            valid: false,
            errors: [err instanceof Error ? err.message : String(err)],
        };
    }
}

/**
 * Validate a value against a JSON Schema for a specific key.
 */
export function validateValue(schema: Record<string, unknown>, key: string, value: unknown): { valid: boolean; errors?: string[] } {
    // Look for the key's schema in the top-level properties
    const properties = schema.properties as Record<string, unknown> | undefined;
    if (!properties || !properties[key]) {
        // If there's no schema for this key at top level, check if the schema
        // itself defines the key directly (serialized config schema format)
        const keySchema = schema[key];
        if (!keySchema) {
            return { valid: true }; // No schema to validate against
        }

        // Handle serialized config schema format (stringSchema, booleanSchema, numberSchema)
        if (typeof keySchema === 'string') {
            return validatePrimitiveType(keySchema, value);
        }

        // It's a JSON Schema object — validate directly
        if (typeof keySchema === 'object') {
            return validateWithAjv(keySchema as Record<string, unknown>, value);
        }

        return { valid: true };
    }

    return validateWithAjv(properties[key] as Record<string, unknown>, value);
}

function validatePrimitiveType(schemaType: string, value: unknown): { valid: boolean; errors?: string[] } {
    switch (schemaType) {
        case 'stringSchema':
            if (typeof value !== 'string') {
                return { valid: false, errors: [`Expected string, got ${typeof value}`] };
            }
            return { valid: true };
        case 'booleanSchema':
            if (typeof value !== 'boolean' && value !== 'true' && value !== 'false') {
                return { valid: false, errors: [`Expected boolean, got ${typeof value}`] };
            }
            return { valid: true };
        case 'numberSchema':
            if (typeof value !== 'number' && isNaN(Number(value))) {
                return { valid: false, errors: [`Expected number, got ${typeof value}`] };
            }
            return { valid: true };
        default:
            return { valid: true };
    }
}

function validateWithAjv(schema: Record<string, unknown>, value: unknown): { valid: boolean; errors?: string[] } {
    try {
        const validate = ajv.compile(schema);
        const valid = validate(value);
        if (!valid && validate.errors) {
            return {
                valid: false,
                errors: validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}`),
            };
        }
        return { valid: true };
    } catch (err) {
        return { valid: false, errors: [err instanceof Error ? err.message : String(err)] };
    }
}
