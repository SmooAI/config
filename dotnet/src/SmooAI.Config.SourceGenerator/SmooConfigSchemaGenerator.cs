using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;

namespace SmooAI.Config.SourceGenerator;

/// <summary>
/// Incremental source generator that reads a <c>schema.json</c> file from the
/// consumer project's <c>AdditionalFiles</c> and emits strongly-typed static
/// <c>ConfigKey&lt;T&gt;</c> properties under <c>SmooAI.Config.Generated</c>.
/// </summary>
/// <remarks>
/// <para>
/// Consumers opt in by including the schema file in their csproj:
/// </para>
/// <code>
/// &lt;ItemGroup&gt;
///   &lt;AdditionalFiles Include="schema.json" SmooConfigSchema="true" /&gt;
/// &lt;/ItemGroup&gt;
/// </code>
/// <para>
/// The generator recognizes two schema shapes (both produced by the
/// <c>@smooai/config</c> CLI):
/// </para>
/// <list type="number">
///   <item><description>JSON-Schema shape — <c>{ properties: { public, secret, featureFlags } }</c></description></item>
///   <item><description>Serialized <c>defineConfig</c> shape — <c>{ publicConfigSchema, secretConfigSchema, featureFlagSchema }</c></description></item>
/// </list>
/// </remarks>
[Generator(LanguageNames.CSharp)]
public sealed class SmooConfigSchemaGenerator : IIncrementalGenerator
{
    private const string SchemaMetadataKey = "SmooConfigSchema";
    private const string DefaultNamespace = "SmooAI.Config.Generated";

    /// <inheritdoc />
    public void Initialize(IncrementalGeneratorInitializationContext context)
    {
        var schemaFiles = context.AdditionalTextsProvider
            .Combine(context.AnalyzerConfigOptionsProvider)
            .Where(pair =>
            {
                var (file, optionsProvider) = pair;
                var options = optionsProvider.GetOptions(file);
                if (options.TryGetValue($"build_metadata.AdditionalFiles.{SchemaMetadataKey}", out var flag)
                    && !string.IsNullOrEmpty(flag)
                    && !string.Equals(flag, "false", StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
                // Convention: a root-level `schema.json` is treated as a schema.
                var name = System.IO.Path.GetFileName(file.Path);
                return string.Equals(name, "schema.json", StringComparison.OrdinalIgnoreCase);
            })
            .Select((pair, cancellationToken) =>
            {
                var (file, optionsProvider) = pair;
                var text = file.GetText(cancellationToken)?.ToString() ?? string.Empty;
                var options = optionsProvider.GetOptions(file);
                options.TryGetValue($"build_metadata.AdditionalFiles.SmooConfigNamespace", out var ns);
                return new SchemaInput(file.Path, text, string.IsNullOrWhiteSpace(ns) ? DefaultNamespace : ns!);
            });

        context.RegisterSourceOutput(schemaFiles, Emit);
    }

    private void Emit(SourceProductionContext context, SchemaInput input)
    {
        ParsedSchema parsed;
        try
        {
            parsed = Parse(input.Text);
        }
        catch (JsonException ex)
        {
            context.ReportDiagnostic(Diagnostic.Create(
                new DiagnosticDescriptor(
                    id: "SMOOCFG001",
                    title: "Invalid schema JSON",
                    messageFormat: "Schema file '{0}' is not valid JSON: {1}",
                    category: "SmooAI.Config",
                    defaultSeverity: DiagnosticSeverity.Error,
                    isEnabledByDefault: true),
                Location.None,
                input.FilePath,
                ex.Message));
            return;
        }

        var source = Render(parsed, input.Namespace);
        context.AddSource("SmooConfigGenerated.g.cs", SourceText.From(source, Encoding.UTF8));
    }

    internal static ParsedSchema Parse(string json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return new ParsedSchema(ImmutableArray<SchemaKey>.Empty, ImmutableArray<SchemaKey>.Empty, ImmutableArray<SchemaKey>.Empty);
        }

        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
        {
            return new ParsedSchema(ImmutableArray<SchemaKey>.Empty, ImmutableArray<SchemaKey>.Empty, ImmutableArray<SchemaKey>.Empty);
        }

        var pub = new List<SchemaKey>();
        var sec = new List<SchemaKey>();
        var flags = new List<SchemaKey>();

        // Shape 1 — JSON-Schema: { properties: { public, secret, featureFlags } }
        if (root.TryGetProperty("properties", out var properties) && properties.ValueKind == JsonValueKind.Object)
        {
            ExtractFromJsonSchemaSection(properties, "public", pub);
            ExtractFromJsonSchemaSection(properties, "secret", sec);
            ExtractFromJsonSchemaSection(properties, "featureFlags", flags);
        }

        // Shape 2 — serialized defineConfig: { publicConfigSchema, secretConfigSchema, featureFlagSchema }
        ExtractFromSerializedObject(root, "publicConfigSchema", pub);
        ExtractFromSerializedObject(root, "secretConfigSchema", sec);
        ExtractFromSerializedObject(root, "featureFlagSchema", flags);

        return new ParsedSchema(pub.ToImmutableArray(), sec.ToImmutableArray(), flags.ToImmutableArray());
    }

    private static void ExtractFromJsonSchemaSection(JsonElement properties, string sectionName, List<SchemaKey> target)
    {
        if (!properties.TryGetProperty(sectionName, out var section) || section.ValueKind != JsonValueKind.Object) return;
        if (!section.TryGetProperty("properties", out var keys) || keys.ValueKind != JsonValueKind.Object) return;
        foreach (var prop in keys.EnumerateObject())
        {
            var type = InferTypeFromJsonSchema(prop.Value);
            target.Add(new SchemaKey(prop.Name, type));
        }
    }

    private static void ExtractFromSerializedObject(JsonElement root, string sectionName, List<SchemaKey> target)
    {
        if (!root.TryGetProperty(sectionName, out var section) || section.ValueKind != JsonValueKind.Object) return;
        foreach (var prop in section.EnumerateObject())
        {
            var type = InferTypeFromSerializedValue(prop.Value);
            // Don't double-register if the JSON-Schema shape already populated
            // the same key above.
            if (target.Any(k => k.Name == prop.Name)) continue;
            target.Add(new SchemaKey(prop.Name, type));
        }
    }

    private static string InferTypeFromJsonSchema(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object) return "string";
        if (!element.TryGetProperty("type", out var typeElement)) return "string";
        if (typeElement.ValueKind != JsonValueKind.String) return "string";
        return typeElement.GetString() switch
        {
            "string" => "string",
            "boolean" => "bool",
            "number" or "integer" => "double",
            _ => "string",
        };
    }

    private static string InferTypeFromSerializedValue(JsonElement element)
    {
        // Serialized schema leafs: "stringSchema" | "booleanSchema" | "numberSchema" | { JSON Schema object }
        if (element.ValueKind == JsonValueKind.String)
        {
            return element.GetString() switch
            {
                "stringSchema" => "string",
                "booleanSchema" => "bool",
                "numberSchema" => "double",
                _ => "string",
            };
        }
        return InferTypeFromJsonSchema(element);
    }

    internal static string Render(ParsedSchema parsed, string ns)
    {
        var sb = new StringBuilder();
        sb.AppendLine("// <auto-generated/>");
        sb.AppendLine("#nullable enable");
        sb.AppendLine();
        sb.AppendLine("using SmooAI.Config.Models;");
        sb.AppendLine("using SmooAI.Config.Typed;");
        sb.AppendLine();
        sb.Append("namespace ").Append(ns).AppendLine(";");
        sb.AppendLine();

        RenderSection(sb, "Public", parsed.PublicKeys, "ConfigTier.Public");
        sb.AppendLine();
        RenderSection(sb, "Secrets", parsed.SecretKeys, "ConfigTier.Secret");
        sb.AppendLine();
        RenderSection(sb, "FeatureFlags", parsed.FeatureFlagKeys, "ConfigTier.FeatureFlag");

        return sb.ToString();
    }

    private static void RenderSection(StringBuilder sb, string className, ImmutableArray<SchemaKey> keys, string tierExpression)
    {
        sb.Append("/// <summary>Generated typed keys for the <c>").Append(className).AppendLine("</c> tier.</summary>");
        sb.Append("public static class ").AppendLine(className);
        sb.AppendLine("{");
        foreach (var key in keys)
        {
            var propertyName = ToPascalCase(key.Name);
            sb.Append("    /// <summary>Config key <c>").Append(key.Name).AppendLine("</c>.</summary>");
            sb.Append("    public static global::SmooAI.Config.Typed.ConfigKey<").Append(key.ClrType).Append("> ")
              .Append(propertyName)
              .Append(" { get; } = new global::SmooAI.Config.Typed.ConfigKey<").Append(key.ClrType).Append(">(")
              .Append('"').Append(EscapeString(key.Name)).Append('"').Append(", ")
              .Append("global::SmooAI.Config.Models.").Append(tierExpression).Append(")")
              .AppendLine(";");
        }
        sb.AppendLine("}");
    }

    private static string ToPascalCase(string key)
    {
        if (string.IsNullOrEmpty(key)) return key;
        // Split on non-alphanumerics and re-join with each part capitalized.
        var parts = new List<string>();
        var buf = new StringBuilder();
        bool prevUpper = false;
        foreach (var ch in key)
        {
            if (!char.IsLetterOrDigit(ch))
            {
                if (buf.Length > 0) { parts.Add(buf.ToString()); buf.Clear(); }
                prevUpper = false;
                continue;
            }
            // Split camelCase: lowercase->uppercase transition starts a new word.
            if (char.IsUpper(ch) && buf.Length > 0 && !prevUpper)
            {
                parts.Add(buf.ToString());
                buf.Clear();
            }
            buf.Append(ch);
            prevUpper = char.IsUpper(ch);
        }
        if (buf.Length > 0) parts.Add(buf.ToString());
        var sb = new StringBuilder();
        foreach (var p in parts)
        {
            if (p.Length == 0) continue;
            sb.Append(char.ToUpperInvariant(p[0]));
            if (p.Length > 1) sb.Append(p.Substring(1).ToLowerInvariant());
        }
        var result = sb.ToString();
        if (result.Length == 0) return "Value";
        if (char.IsDigit(result[0])) result = "_" + result;
        return result;
    }

    private static string EscapeString(string s) => s.Replace("\\", "\\\\").Replace("\"", "\\\"");

    internal sealed class SchemaInput
    {
        public string FilePath { get; }
        public string Text { get; }
        public string Namespace { get; }
        public SchemaInput(string filePath, string text, string ns)
        {
            FilePath = filePath;
            Text = text;
            Namespace = ns;
        }
    }

    internal sealed class SchemaKey
    {
        public string Name { get; }
        public string ClrType { get; }
        public SchemaKey(string name, string clrType)
        {
            Name = name;
            ClrType = clrType;
        }
    }

    internal sealed class ParsedSchema
    {
        public ImmutableArray<SchemaKey> PublicKeys { get; }
        public ImmutableArray<SchemaKey> SecretKeys { get; }
        public ImmutableArray<SchemaKey> FeatureFlagKeys { get; }
        public ParsedSchema(
            ImmutableArray<SchemaKey> publicKeys,
            ImmutableArray<SchemaKey> secretKeys,
            ImmutableArray<SchemaKey> featureFlagKeys)
        {
            PublicKeys = publicKeys;
            SecretKeys = secretKeys;
            FeatureFlagKeys = featureFlagKeys;
        }
    }
}
