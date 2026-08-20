using System.Text.Json;

namespace SmooAI.Config.Schema;

/// <summary>A single schema-validation error with actionable context.</summary>
/// <param name="Path">JSON-pointer-ish location of the offending keyword.</param>
/// <param name="Keyword">The keyword that failed.</param>
/// <param name="Message">What is wrong.</param>
/// <param name="Suggestion">A supported alternative.</param>
public sealed record SchemaValidationError(string Path, string Keyword, string Message, string Suggestion);

/// <summary>Outcome of validating a schema against the cross-language subset.</summary>
/// <param name="Valid">True when no errors were found.</param>
/// <param name="Errors">Every error found, in traversal order.</param>
public sealed record SchemaValidationResult(bool Valid, IReadOnlyList<SchemaValidationError> Errors);

/// <summary>
/// Validates that a JSON Schema uses only the subset of keywords every SmooAI
/// SDK language can reliably support.
/// </summary>
/// <remarks>
/// Port of <c>go/config/schema_validator.go</c> / <c>src/schema-spec/smooai-config-schema-spec.ts</c>.
/// The keyword tables here are NOT the source of truth for behaviour — the
/// shared corpus at <c>test-fixtures/schema-validation-cases.json</c> is, and
/// this port is held to it by the same 24 cases TypeScript, Python, Rust and Go
/// are held to. A hand-mirrored table that nothing cross-checks is exactly how
/// these ports drift.
/// </remarks>
public static class SchemaValidator
{
    private static readonly HashSet<string> SupportedKeywords = new(StringComparer.Ordinal)
    {
        // Core
        "type", "properties", "required", "enum", "const", "default",
        // Metadata
        "title", "description", "$schema",
        // String
        "minLength", "maxLength", "pattern", "format",
        // Numeric
        "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
        // Array
        "items", "minItems", "maxItems", "uniqueItems",
        // Object
        "additionalProperties",
        // Composition
        "anyOf", "oneOf", "allOf",
        // References
        "$ref", "$defs", "definitions",
    };

    private const string ConditionalMessage = "Conditional schemas (if/then/else) are not supported across all SDK languages.";
    private const string ConditionalSuggestion = "Use \"oneOf\" or \"anyOf\" with discriminator properties instead.";

    private static readonly Dictionary<string, (string Message, string Suggestion)> RejectedKeywords = new(StringComparer.Ordinal)
    {
        ["if"] = (ConditionalMessage, ConditionalSuggestion),
        ["then"] = (ConditionalMessage, ConditionalSuggestion),
        ["else"] = (ConditionalMessage, ConditionalSuggestion),
        ["patternProperties"] = (
            "\"patternProperties\" is not supported across all SDK languages.",
            "Use explicit \"properties\" with known key names, or \"additionalProperties\" with a type constraint."),
        ["propertyNames"] = (
            "\"propertyNames\" is not supported across all SDK languages.",
            "Validate property names in application code instead."),
        ["dependencies"] = (
            "\"dependencies\" is not supported across all SDK languages.",
            "Use \"required\" within \"oneOf\"/\"anyOf\" variants to express conditional requirements."),
        ["contains"] = (
            "\"contains\" is not supported across all SDK languages.",
            "Use \"items\" with a union type (\"anyOf\") instead."),
        ["not"] = (
            "\"not\" is not supported across all SDK languages.",
            "Express the constraint positively using \"enum\", \"oneOf\", or validation in application code."),
        ["prefixItems"] = (
            "\"prefixItems\" (tuple validation) is not supported across all SDK languages.",
            "Use an \"object\" with named fields instead of a positional tuple."),
        ["unevaluatedProperties"] = (
            "\"unevaluatedProperties\" is not supported across all SDK languages.",
            "Use \"additionalProperties\" instead."),
        ["unevaluatedItems"] = (
            "\"unevaluatedItems\" is not supported across all SDK languages.",
            "Use \"items\" with a specific schema instead."),
    };

    private static readonly HashSet<string> SupportedFormats = new(StringComparer.Ordinal)
    {
        "email", "uri", "uuid", "date-time", "ipv4", "ipv6",
    };

    /// <summary>
    /// Validate a JSON Schema against the cross-language-compatible subset.
    /// </summary>
    /// <param name="schema">The schema document to check.</param>
    /// <returns>A result carrying every error found; <c>Valid</c> is true when there are none.</returns>
    public static SchemaValidationResult ValidateSmooaiSchema(JsonElement schema)
    {
        var errors = new List<SchemaValidationError>();
        WalkSchema(schema, string.Empty, errors);
        return new SchemaValidationResult(errors.Count == 0, errors);
    }

    private static void WalkSchema(JsonElement node, string path, List<SchemaValidationError> errors)
    {
        if (node.ValueKind != JsonValueKind.Object) return;

        // The root reports as "/" rather than the empty string, matching the
        // other ports' fixture expectations.
        var effectivePath = path.Length == 0 ? "/" : path;

        foreach (var property in node.EnumerateObject())
        {
            if (RejectedKeywords.TryGetValue(property.Name, out var rejected))
            {
                errors.Add(new SchemaValidationError(effectivePath, property.Name, rejected.Message, rejected.Suggestion));
                continue;
            }

            if (!SupportedKeywords.Contains(property.Name)) continue;

            if (property.Name == "format" && property.Value.ValueKind == JsonValueKind.String)
            {
                var format = property.Value.GetString();
                if (format is not null && !SupportedFormats.Contains(format))
                {
                    errors.Add(new SchemaValidationError(
                        effectivePath,
                        "format",
                        $"Format \"{format}\" is not supported across all SDK languages.",
                        "Supported formats: date-time, email, ipv4, ipv6, uri, uuid. Use \"pattern\" for custom string validation."));
                }
            }
        }

        if (node.TryGetProperty("properties", out var properties) && properties.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in properties.EnumerateObject())
            {
                WalkSchema(property.Value, $"{path}/properties/{property.Name}", errors);
            }
        }

        if (node.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Object)
        {
            WalkSchema(items, $"{path}/items", errors);
        }

        if (node.TryGetProperty("additionalProperties", out var additional) && additional.ValueKind == JsonValueKind.Object)
        {
            WalkSchema(additional, $"{path}/additionalProperties", errors);
        }

        foreach (var compositionKeyword in new[] { "anyOf", "oneOf", "allOf" })
        {
            if (!node.TryGetProperty(compositionKeyword, out var composition) || composition.ValueKind != JsonValueKind.Array) continue;

            var index = 0;
            foreach (var subSchema in composition.EnumerateArray())
            {
                WalkSchema(subSchema, $"{path}/{compositionKeyword}/{index}", errors);
                index++;
            }
        }

        foreach (var defsKeyword in new[] { "$defs", "definitions" })
        {
            if (!node.TryGetProperty(defsKeyword, out var defs) || defs.ValueKind != JsonValueKind.Object) continue;

            foreach (var definition in defs.EnumerateObject())
            {
                WalkSchema(definition.Value, $"{path}/{defsKeyword}/{definition.Name}", errors);
            }
        }
    }
}
