using System.Text.Json;

namespace SmooAI.Config.Build;

/// <summary>
/// Classifier factory that routes each key into <c>public</c>, <c>secret</c>,
/// or <c>skip</c> based on a schema description.
/// </summary>
/// <remarks>
/// <para>
/// Two schema shapes are recognized — both produced by the first-party
/// <c>@smooai/config</c> CLI:
/// </para>
/// <list type="number">
///   <item>
///     <description>
///       The JSON Schema shape written by <c>smooai-config init</c>:
///       <c>{ properties: { public: {}, secret: {}, featureFlags: {} } }</c>.
///     </description>
///   </item>
///   <item>
///     <description>
///       The serialized <c>defineConfig</c> shape:
///       <c>{ publicConfigSchema: {}, secretConfigSchema: {}, featureFlagSchema: {} }</c>.
///     </description>
///   </item>
/// </list>
/// <para>
/// Unknown keys default to <c>public</c>, matching TS/Python behavior.
/// </para>
/// </remarks>
public static class SchemaClassifier
{
    /// <summary>
    /// Parse a <c>schema.json</c> file on disk into a classifier.
    /// </summary>
    public static Func<string, JsonElement, ClassifyResult> FromSchemaFile(string schemaPath)
    {
        if (string.IsNullOrWhiteSpace(schemaPath)) throw new ArgumentException("Schema path is required.", nameof(schemaPath));
        var json = File.ReadAllText(schemaPath);
        return FromSchemaJson(json);
    }

    /// <summary>
    /// Parse a schema JSON string (either JSON-Schema shape or serialized
    /// <c>defineConfig</c> shape) into a classifier.
    /// </summary>
    public static Func<string, JsonElement, ClassifyResult> FromSchemaJson(string schemaJson)
    {
        if (string.IsNullOrWhiteSpace(schemaJson)) throw new ArgumentException("Schema JSON is required.", nameof(schemaJson));
        using var doc = JsonDocument.Parse(schemaJson);
        return FromSchemaElement(doc.RootElement);
    }

    /// <summary>
    /// Build a classifier from a parsed <see cref="JsonElement"/>.
    /// </summary>
    public static Func<string, JsonElement, ClassifyResult> FromSchemaElement(JsonElement root)
    {
        var publicKeys = new HashSet<string>(StringComparer.Ordinal);
        var secretKeys = new HashSet<string>(StringComparer.Ordinal);
        var flagKeys = new HashSet<string>(StringComparer.Ordinal);

        // Shape 1: JSON-Schema shape.
        if (root.ValueKind == JsonValueKind.Object
            && root.TryGetProperty("properties", out var properties)
            && properties.ValueKind == JsonValueKind.Object)
        {
            AddKeysFromSection(properties, "public", publicKeys);
            AddKeysFromSection(properties, "secret", secretKeys);
            AddKeysFromSection(properties, "featureFlags", flagKeys);
        }

        // Shape 2: serialized defineConfig shape.
        if (root.ValueKind == JsonValueKind.Object)
        {
            AddKeysFromObject(root, "publicConfigSchema", publicKeys);
            AddKeysFromObject(root, "secretConfigSchema", secretKeys);
            AddKeysFromObject(root, "featureFlagSchema", flagKeys);
        }

        return FromKeys(publicKeys, secretKeys, flagKeys);
    }

    /// <summary>
    /// Build a classifier from explicit key sets. Useful when callers
    /// already extracted the keys from some other source.
    /// </summary>
    public static Func<string, JsonElement, ClassifyResult> FromKeys(
        IEnumerable<string>? publicKeys,
        IEnumerable<string>? secretKeys,
        IEnumerable<string>? featureFlagKeys)
    {
        var pub = new HashSet<string>(publicKeys ?? Enumerable.Empty<string>(), StringComparer.Ordinal);
        var sec = new HashSet<string>(secretKeys ?? Enumerable.Empty<string>(), StringComparer.Ordinal);
        var flags = new HashSet<string>(featureFlagKeys ?? Enumerable.Empty<string>(), StringComparer.Ordinal);

        return (key, _) =>
        {
            if (sec.Contains(key)) return ClassifyResult.Secret;
            if (pub.Contains(key)) return ClassifyResult.Public;
            if (flags.Contains(key)) return ClassifyResult.Skip;
            return ClassifyResult.Public;
        };
    }

    private static void AddKeysFromSection(JsonElement properties, string sectionName, HashSet<string> target)
    {
        if (!properties.TryGetProperty(sectionName, out var section) || section.ValueKind != JsonValueKind.Object) return;
        if (!section.TryGetProperty("properties", out var keys) || keys.ValueKind != JsonValueKind.Object) return;
        foreach (var prop in keys.EnumerateObject())
        {
            target.Add(prop.Name);
        }
    }

    private static void AddKeysFromObject(JsonElement root, string objectName, HashSet<string> target)
    {
        if (!root.TryGetProperty(objectName, out var section) || section.ValueKind != JsonValueKind.Object) return;
        foreach (var prop in section.EnumerateObject())
        {
            target.Add(prop.Name);
        }
    }
}
