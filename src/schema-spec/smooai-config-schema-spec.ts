/**
 * Cross-language JSON Schema validation for the Smoo AI config SDK.
 *
 * Validates that a JSON Schema uses only the subset of keywords that all
 * four language SDKs (TypeScript, Python, Rust, Go) can reliably support.
 */

export interface SchemaValidationError {
    path: string;
    keyword: string;
    message: string;
    suggestion: string;
}

export interface SchemaValidationResult {
    valid: boolean;
    errors: SchemaValidationError[];
}

/** Keywords supported across all four SDK languages. */
const SUPPORTED_KEYWORDS = new Set([
    // Core
    'type',
    'properties',
    'required',
    'enum',
    'const',
    'default',
    // Metadata
    'title',
    'description',
    '$schema',
    // String
    'minLength',
    'maxLength',
    'pattern',
    'format',
    // Numeric
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    // Array
    'items',
    'minItems',
    'maxItems',
    'uniqueItems',
    // Object
    'additionalProperties',
    // Composition
    'anyOf',
    'oneOf',
    'allOf',
    // References
    '$ref',
    '$defs',
    'definitions',
]);

/** Keywords explicitly rejected with actionable error messages. */
const REJECTED_KEYWORDS: Record<string, { message: string; suggestion: string }> = {
    if: {
        message: 'Conditional schemas (if/then/else) are not supported across all SDK languages.',
        suggestion: 'Use "oneOf" or "anyOf" with discriminator properties instead.',
    },
    then: {
        message: 'Conditional schemas (if/then/else) are not supported across all SDK languages.',
        suggestion: 'Use "oneOf" or "anyOf" with discriminator properties instead.',
    },
    else: {
        message: 'Conditional schemas (if/then/else) are not supported across all SDK languages.',
        suggestion: 'Use "oneOf" or "anyOf" with discriminator properties instead.',
    },
    patternProperties: {
        message: '"patternProperties" is not supported across all SDK languages.',
        suggestion: 'Use explicit "properties" with known key names, or "additionalProperties" with a type constraint.',
    },
    propertyNames: {
        message: '"propertyNames" is not supported across all SDK languages.',
        suggestion: 'Validate property names in application code instead.',
    },
    dependencies: {
        message: '"dependencies" is not supported across all SDK languages.',
        suggestion: 'Use "required" within "oneOf"/"anyOf" variants to express conditional requirements.',
    },
    contains: {
        message: '"contains" is not supported across all SDK languages.',
        suggestion: 'Use "items" with a union type ("anyOf") instead.',
    },
    not: {
        message: '"not" is not supported across all SDK languages.',
        suggestion: 'Express the constraint positively using "enum", "oneOf", or validation in application code.',
    },
    prefixItems: {
        message: '"prefixItems" (tuple validation) is not supported across all SDK languages.',
        suggestion: 'Use an "object" with named fields instead of a positional tuple.',
    },
    unevaluatedProperties: {
        message: '"unevaluatedProperties" is not supported across all SDK languages.',
        suggestion: 'Use "additionalProperties" instead.',
    },
    unevaluatedItems: {
        message: '"unevaluatedItems" is not supported across all SDK languages.',
        suggestion: 'Use "items" with a specific schema instead.',
    },
};

/** Formats supported across all four SDKs. */
const SUPPORTED_FORMATS = new Set(['email', 'uri', 'uuid', 'date-time', 'ipv4', 'ipv6']);

/**
 * Validate that a JSON Schema uses only the cross-language-compatible subset.
 *
 * Walks the schema tree and reports unsupported keywords with actionable
 * error messages and suggestions for compatible alternatives.
 */
export function validateSmooaiSchema(schema: Record<string, unknown>): SchemaValidationResult {
    const errors: SchemaValidationError[] = [];
    walkSchema(schema, '', errors);
    return { valid: errors.length === 0, errors };
}

function walkSchema(node: unknown, path: string, errors: SchemaValidationError[]): void {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
        return;
    }

    const obj = node as Record<string, unknown>;

    for (const key of Object.keys(obj)) {
        // Check for rejected keywords first (specific error messages)
        if (key in REJECTED_KEYWORDS) {
            const info = REJECTED_KEYWORDS[key];
            errors.push({
                path: path || '/',
                keyword: key,
                message: info.message,
                suggestion: info.suggestion,
            });
            continue;
        }

        // Skip known supported keywords — they're fine
        if (SUPPORTED_KEYWORDS.has(key)) {
            // Validate format values
            if (key === 'format' && typeof obj[key] === 'string' && !SUPPORTED_FORMATS.has(obj[key] as string)) {
                errors.push({
                    path: path || '/',
                    keyword: 'format',
                    message: `Format "${obj[key]}" is not supported across all SDK languages.`,
                    suggestion: `Supported formats: ${[...SUPPORTED_FORMATS].join(', ')}. Use "pattern" for custom string validation.`,
                });
            }
            continue;
        }

        // Unknown keywords that aren't standard JSON Schema — ignore
        // (could be vendor extensions like x-*, or $id, etc.)
    }

    // Recurse into sub-schemas
    if (obj.properties && typeof obj.properties === 'object') {
        const props = obj.properties as Record<string, unknown>;
        for (const [propName, propSchema] of Object.entries(props)) {
            walkSchema(propSchema, `${path}/properties/${propName}`, errors);
        }
    }

    if (obj.items && typeof obj.items === 'object') {
        walkSchema(obj.items, `${path}/items`, errors);
    }

    if (obj.additionalProperties && typeof obj.additionalProperties === 'object') {
        walkSchema(obj.additionalProperties, `${path}/additionalProperties`, errors);
    }

    // Composition keywords
    for (const compKey of ['anyOf', 'oneOf', 'allOf'] as const) {
        if (Array.isArray(obj[compKey])) {
            (obj[compKey] as unknown[]).forEach((subSchema, i) => {
                walkSchema(subSchema, `${path}/${compKey}/${i}`, errors);
            });
        }
    }

    // $defs / definitions
    for (const defsKey of ['$defs', 'definitions'] as const) {
        if (obj[defsKey] && typeof obj[defsKey] === 'object') {
            const defs = obj[defsKey] as Record<string, unknown>;
            for (const [defName, defSchema] of Object.entries(defs)) {
                walkSchema(defSchema, `${path}/${defsKey}/${defName}`, errors);
            }
        }
    }
}
