"""Cross-language JSON Schema validation for the Smoo AI config SDK.

Validates that a JSON Schema uses only the subset of keywords that all
four language SDKs (TypeScript, Python, Rust, Go) can reliably support.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class SchemaValidationError:
    """A single validation error with actionable context."""

    path: str
    keyword: str
    message: str
    suggestion: str


@dataclass
class SchemaValidationResult:
    """Result of schema validation."""

    valid: bool
    errors: list[SchemaValidationError] = field(default_factory=list)


# Keywords supported across all four SDK languages.
_SUPPORTED_KEYWORDS: set[str] = {
    # Core
    "type",
    "properties",
    "required",
    "enum",
    "const",
    "default",
    # Metadata
    "title",
    "description",
    "$schema",
    # String
    "minLength",
    "maxLength",
    "pattern",
    "format",
    # Numeric
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    # Array
    "items",
    "minItems",
    "maxItems",
    "uniqueItems",
    # Object
    "additionalProperties",
    # Composition
    "anyOf",
    "oneOf",
    "allOf",
    # References
    "$ref",
    "$defs",
    "definitions",
}

# Keywords explicitly rejected with actionable error messages.
_REJECTED_KEYWORDS: dict[str, dict[str, str]] = {
    "if": {
        "message": "Conditional schemas (if/then/else) are not supported across all SDK languages.",
        "suggestion": 'Use "oneOf" or "anyOf" with discriminator properties instead.',
    },
    "then": {
        "message": "Conditional schemas (if/then/else) are not supported across all SDK languages.",
        "suggestion": 'Use "oneOf" or "anyOf" with discriminator properties instead.',
    },
    "else": {
        "message": "Conditional schemas (if/then/else) are not supported across all SDK languages.",
        "suggestion": 'Use "oneOf" or "anyOf" with discriminator properties instead.',
    },
    "patternProperties": {
        "message": '"patternProperties" is not supported across all SDK languages.',
        "suggestion": (
            'Use explicit "properties" with known key names, or "additionalProperties" with a type constraint.'
        ),
    },
    "propertyNames": {
        "message": '"propertyNames" is not supported across all SDK languages.',
        "suggestion": "Validate property names in application code instead.",
    },
    "dependencies": {
        "message": '"dependencies" is not supported across all SDK languages.',
        "suggestion": 'Use "required" within "oneOf"/"anyOf" variants to express conditional requirements.',
    },
    "contains": {
        "message": '"contains" is not supported across all SDK languages.',
        "suggestion": 'Use "items" with a union type ("anyOf") instead.',
    },
    "not": {
        "message": '"not" is not supported across all SDK languages.',
        "suggestion": 'Express the constraint positively using "enum", "oneOf", or validation in application code.',
    },
    "prefixItems": {
        "message": '"prefixItems" (tuple validation) is not supported across all SDK languages.',
        "suggestion": 'Use an "object" with named fields instead of a positional tuple.',
    },
    "unevaluatedProperties": {
        "message": '"unevaluatedProperties" is not supported across all SDK languages.',
        "suggestion": 'Use "additionalProperties" instead.',
    },
    "unevaluatedItems": {
        "message": '"unevaluatedItems" is not supported across all SDK languages.',
        "suggestion": 'Use "items" with a specific schema instead.',
    },
}

# Formats supported across all four SDKs.
_SUPPORTED_FORMATS: set[str] = {"email", "uri", "uuid", "date-time", "ipv4", "ipv6"}


def validate_smooai_schema(schema: dict[str, Any]) -> SchemaValidationResult:
    """Validate that a JSON Schema uses only the cross-language-compatible subset.

    Walks the schema tree and reports unsupported keywords with actionable
    error messages and suggestions for compatible alternatives.
    """
    errors: list[SchemaValidationError] = []
    _walk_schema(schema, "", errors)
    return SchemaValidationResult(valid=len(errors) == 0, errors=errors)


def _walk_schema(
    node: Any,
    path: str,
    errors: list[SchemaValidationError],
) -> None:
    if not isinstance(node, dict):
        return

    for key in node:
        # Check for rejected keywords first (specific error messages)
        if key in _REJECTED_KEYWORDS:
            info = _REJECTED_KEYWORDS[key]
            errors.append(
                SchemaValidationError(
                    path=path or "/",
                    keyword=key,
                    message=info["message"],
                    suggestion=info["suggestion"],
                )
            )
            continue

        # Skip known supported keywords
        if key in _SUPPORTED_KEYWORDS:
            # Validate format values
            if key == "format" and isinstance(node[key], str) and node[key] not in _SUPPORTED_FORMATS:
                errors.append(
                    SchemaValidationError(
                        path=path or "/",
                        keyword="format",
                        message=f'Format "{node[key]}" is not supported across all SDK languages.',
                        suggestion=f"Supported formats: {', '.join(sorted(_SUPPORTED_FORMATS))}. "
                        'Use "pattern" for custom string validation.',
                    )
                )
            continue

    # Recurse into sub-schemas
    props = node.get("properties")
    if isinstance(props, dict):
        for prop_name, prop_schema in props.items():
            _walk_schema(prop_schema, f"{path}/properties/{prop_name}", errors)

    items = node.get("items")
    if isinstance(items, dict):
        _walk_schema(items, f"{path}/items", errors)

    additional = node.get("additionalProperties")
    if isinstance(additional, dict):
        _walk_schema(additional, f"{path}/additionalProperties", errors)

    # Composition keywords
    for comp_key in ("anyOf", "oneOf", "allOf"):
        comp = node.get(comp_key)
        if isinstance(comp, list):
            for i, sub_schema in enumerate(comp):
                _walk_schema(sub_schema, f"{path}/{comp_key}/{i}", errors)

    # $defs / definitions
    for defs_key in ("$defs", "definitions"):
        defs = node.get(defs_key)
        if isinstance(defs, dict):
            for def_name, def_schema in defs.items():
                _walk_schema(def_schema, f"{path}/{defs_key}/{def_name}", errors)
