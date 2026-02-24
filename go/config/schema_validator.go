// Package config provides cross-language JSON Schema validation.
//
// Validates that a JSON Schema uses only the subset of keywords that all
// four language SDKs (TypeScript, Python, Rust, Go) can reliably support.
package config

import "fmt"

// SchemaValidationError represents a single validation error with actionable context.
type SchemaValidationError struct {
	Path       string `json:"path"`
	Keyword    string `json:"keyword"`
	Message    string `json:"message"`
	Suggestion string `json:"suggestion"`
}

// SchemaValidationResult holds the result of schema validation.
type SchemaValidationResult struct {
	Valid  bool                    `json:"valid"`
	Errors []SchemaValidationError `json:"errors"`
}

// Keywords supported across all four SDK languages.
var supportedKeywords = map[string]bool{
	// Core
	"type": true, "properties": true, "required": true, "enum": true, "const": true, "default": true,
	// Metadata
	"title": true, "description": true, "$schema": true,
	// String
	"minLength": true, "maxLength": true, "pattern": true, "format": true,
	// Numeric
	"minimum": true, "maximum": true, "exclusiveMinimum": true, "exclusiveMaximum": true, "multipleOf": true,
	// Array
	"items": true, "minItems": true, "maxItems": true, "uniqueItems": true,
	// Object
	"additionalProperties": true,
	// Composition
	"anyOf": true, "oneOf": true, "allOf": true,
	// References
	"$ref": true, "$defs": true, "definitions": true,
}

type rejectedKeyword struct {
	message    string
	suggestion string
}

var rejectedKeywords = map[string]rejectedKeyword{
	"if": {
		message:    "Conditional schemas (if/then/else) are not supported across all SDK languages.",
		suggestion: `Use "oneOf" or "anyOf" with discriminator properties instead.`,
	},
	"then": {
		message:    "Conditional schemas (if/then/else) are not supported across all SDK languages.",
		suggestion: `Use "oneOf" or "anyOf" with discriminator properties instead.`,
	},
	"else": {
		message:    "Conditional schemas (if/then/else) are not supported across all SDK languages.",
		suggestion: `Use "oneOf" or "anyOf" with discriminator properties instead.`,
	},
	"patternProperties": {
		message:    `"patternProperties" is not supported across all SDK languages.`,
		suggestion: `Use explicit "properties" with known key names, or "additionalProperties" with a type constraint.`,
	},
	"propertyNames": {
		message:    `"propertyNames" is not supported across all SDK languages.`,
		suggestion: "Validate property names in application code instead.",
	},
	"dependencies": {
		message:    `"dependencies" is not supported across all SDK languages.`,
		suggestion: `Use "required" within "oneOf"/"anyOf" variants to express conditional requirements.`,
	},
	"contains": {
		message:    `"contains" is not supported across all SDK languages.`,
		suggestion: `Use "items" with a union type ("anyOf") instead.`,
	},
	"not": {
		message:    `"not" is not supported across all SDK languages.`,
		suggestion: `Express the constraint positively using "enum", "oneOf", or validation in application code.`,
	},
	"prefixItems": {
		message:    `"prefixItems" (tuple validation) is not supported across all SDK languages.`,
		suggestion: `Use an "object" with named fields instead of a positional tuple.`,
	},
	"unevaluatedProperties": {
		message:    `"unevaluatedProperties" is not supported across all SDK languages.`,
		suggestion: `Use "additionalProperties" instead.`,
	},
	"unevaluatedItems": {
		message:    `"unevaluatedItems" is not supported across all SDK languages.`,
		suggestion: `Use "items" with a specific schema instead.`,
	},
}

var supportedFormats = map[string]bool{
	"email": true, "uri": true, "uuid": true, "date-time": true, "ipv4": true, "ipv6": true,
}

// ValidateSmooaiSchema validates that a JSON Schema uses only the cross-language-compatible subset.
func ValidateSmooaiSchema(schema map[string]any) SchemaValidationResult {
	errors := make([]SchemaValidationError, 0)
	walkSchema(schema, "", &errors)
	return SchemaValidationResult{
		Valid:  len(errors) == 0,
		Errors: errors,
	}
}

func walkSchema(node any, path string, errors *[]SchemaValidationError) {
	obj, ok := node.(map[string]any)
	if !ok {
		return
	}

	effectivePath := path
	if effectivePath == "" {
		effectivePath = "/"
	}

	for key := range obj {
		// Check for rejected keywords first
		if rejected, found := rejectedKeywords[key]; found {
			*errors = append(*errors, SchemaValidationError{
				Path:       effectivePath,
				Keyword:    key,
				Message:    rejected.message,
				Suggestion: rejected.suggestion,
			})
			continue
		}

		// Skip supported keywords
		if supportedKeywords[key] {
			// Validate format values
			if key == "format" {
				if fmt, ok := obj[key].(string); ok {
					if !supportedFormats[fmt] {
						*errors = append(*errors, SchemaValidationError{
							Path:       effectivePath,
							Keyword:    "format",
							Message:    fmt2("Format %q is not supported across all SDK languages.", fmt),
							Suggestion: `Supported formats: date-time, email, ipv4, ipv6, uri, uuid. Use "pattern" for custom string validation.`,
						})
					}
				}
			}
			continue
		}
	}

	// Recurse into sub-schemas
	if props, ok := obj["properties"].(map[string]any); ok {
		for propName, propSchema := range props {
			walkSchema(propSchema, path+"/properties/"+propName, errors)
		}
	}

	if items, ok := obj["items"].(map[string]any); ok {
		walkSchema(items, path+"/items", errors)
	}

	if additional, ok := obj["additionalProperties"].(map[string]any); ok {
		walkSchema(additional, path+"/additionalProperties", errors)
	}

	// Composition keywords
	for _, compKey := range []string{"anyOf", "oneOf", "allOf"} {
		if arr, ok := obj[compKey].([]any); ok {
			for i, subSchema := range arr {
				walkSchema(subSchema, fmt2("%s/%s/%d", path, compKey, i), errors)
			}
		}
	}

	// $defs / definitions
	for _, defsKey := range []string{"$defs", "definitions"} {
		if defs, ok := obj[defsKey].(map[string]any); ok {
			for defName, defSchema := range defs {
				walkSchema(defSchema, fmt2("%s/%s/%s", path, defsKey, defName), errors)
			}
		}
	}
}

// fmt2 is a shorthand for fmt.Sprintf.
func fmt2(format string, args ...any) string {
	return fmt.Sprintf(format, args...)
}
