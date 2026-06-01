using System.Text.Json;

namespace SmooAI.Config.Container;

/// <summary>
/// The set of config keys a service declares, partitioned into public, secret,
/// and feature-flag tiers. This is the .NET analog of the TS <c>defineConfig</c>
/// schema that <see cref="ContainerConfig.InitContainerConfigAsync"/> takes:
/// it tells the container handle which keys exist (so reads can be validated)
/// and which tier each belongs to.
/// </summary>
/// <remarks>
/// <para>
/// <b>Design fork (matches TS):</b> the schema carries no required/optional
/// metadata, so container mode treats <b>every</b> declared key as
/// <b>required</b> by default. Use
/// <see cref="InitContainerConfigOptions.OptionalKeys"/> to opt specific keys
/// out of fail-loud resolution.
/// </para>
/// <para>
/// Build one from explicit key sets, or parse a <c>schema.json</c> /
/// serialized <c>defineConfig</c> object via <see cref="FromSchemaElement"/> /
/// <see cref="FromSchemaJson"/> (same shapes the
/// <see cref="Build.SchemaClassifier"/> recognizes).
/// </para>
/// </remarks>
public sealed class ContainerConfigSchema
{
    private readonly IReadOnlyDictionary<string, ConfigKeyTier> _tierByKey;

    /// <summary>Public (client + server) config keys.</summary>
    public IReadOnlyCollection<string> PublicKeys { get; }

    /// <summary>Secret (server-only) config keys.</summary>
    public IReadOnlyCollection<string> SecretKeys { get; }

    /// <summary>Feature-flag keys.</summary>
    public IReadOnlyCollection<string> FeatureFlagKeys { get; }

    /// <summary>All declared keys across every tier.</summary>
    public IReadOnlyCollection<string> AllKeys => _tierByKey.Keys.ToArray();

    /// <summary>Build a schema from explicit, tier-partitioned key sets.</summary>
    /// <param name="publicKeys">Public-tier keys (may be null/empty).</param>
    /// <param name="secretKeys">Secret-tier keys (may be null/empty).</param>
    /// <param name="featureFlagKeys">Feature-flag keys (may be null/empty).</param>
    /// <exception cref="ArgumentException">When the same key appears in more than one tier.</exception>
    public ContainerConfigSchema(
        IEnumerable<string>? publicKeys = null,
        IEnumerable<string>? secretKeys = null,
        IEnumerable<string>? featureFlagKeys = null)
    {
        var pub = Dedup(publicKeys);
        var sec = Dedup(secretKeys);
        var flags = Dedup(featureFlagKeys);

        var tierByKey = new Dictionary<string, ConfigKeyTier>(StringComparer.Ordinal);
        AssignTier(tierByKey, pub, ConfigKeyTier.Public);
        AssignTier(tierByKey, sec, ConfigKeyTier.Secret);
        AssignTier(tierByKey, flags, ConfigKeyTier.FeatureFlag);

        PublicKeys = pub;
        SecretKeys = sec;
        FeatureFlagKeys = flags;
        _tierByKey = tierByKey;
    }

    /// <summary>Whether the given key is declared in any tier.</summary>
    public bool Contains(string key) => _tierByKey.ContainsKey(key);

    /// <summary>
    /// Whether <paramref name="key"/> is declared in the given <paramref name="tier"/>.
    /// </summary>
    public bool ContainsInTier(string key, ConfigKeyTier tier)
        => _tierByKey.TryGetValue(key, out var t) && t == tier;

    /// <summary>
    /// Parse a schema JSON string (JSON-Schema shape or serialized
    /// <c>defineConfig</c> shape) into a <see cref="ContainerConfigSchema"/>.
    /// </summary>
    public static ContainerConfigSchema FromSchemaJson(string schemaJson)
    {
        if (string.IsNullOrWhiteSpace(schemaJson)) throw new ArgumentException("Schema JSON is required.", nameof(schemaJson));
        using var doc = JsonDocument.Parse(schemaJson);
        return FromSchemaElement(doc.RootElement);
    }

    /// <summary>
    /// Parse a schema file on disk into a <see cref="ContainerConfigSchema"/>.
    /// </summary>
    public static ContainerConfigSchema FromSchemaFile(string schemaPath)
    {
        if (string.IsNullOrWhiteSpace(schemaPath)) throw new ArgumentException("Schema path is required.", nameof(schemaPath));
        return FromSchemaJson(File.ReadAllText(schemaPath));
    }

    /// <summary>
    /// Build a schema from a parsed <see cref="JsonElement"/>. Recognizes both
    /// the JSON-Schema shape (<c>{ properties: { public, secret, featureFlags } }</c>)
    /// and the serialized <c>defineConfig</c> shape
    /// (<c>{ publicConfigSchema, secretConfigSchema, featureFlagSchema }</c>).
    /// </summary>
    public static ContainerConfigSchema FromSchemaElement(JsonElement root)
    {
        var publicKeys = new HashSet<string>(StringComparer.Ordinal);
        var secretKeys = new HashSet<string>(StringComparer.Ordinal);
        var flagKeys = new HashSet<string>(StringComparer.Ordinal);

        if (root.ValueKind == JsonValueKind.Object
            && root.TryGetProperty("properties", out var properties)
            && properties.ValueKind == JsonValueKind.Object)
        {
            AddKeysFromSection(properties, "public", publicKeys);
            AddKeysFromSection(properties, "secret", secretKeys);
            AddKeysFromSection(properties, "featureFlags", flagKeys);
        }

        if (root.ValueKind == JsonValueKind.Object)
        {
            AddKeysFromObject(root, "publicConfigSchema", publicKeys);
            AddKeysFromObject(root, "secretConfigSchema", secretKeys);
            AddKeysFromObject(root, "featureFlagSchema", flagKeys);
        }

        return new ContainerConfigSchema(publicKeys, secretKeys, flagKeys);
    }

    private static List<string> Dedup(IEnumerable<string>? keys)
    {
        if (keys is null) return new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var ordered = new List<string>();
        foreach (var k in keys)
        {
            if (string.IsNullOrWhiteSpace(k)) continue;
            if (seen.Add(k)) ordered.Add(k);
        }
        return ordered;
    }

    private static void AssignTier(Dictionary<string, ConfigKeyTier> target, IEnumerable<string> keys, ConfigKeyTier tier)
    {
        foreach (var key in keys)
        {
            if (target.TryGetValue(key, out var existing) && existing != tier)
            {
                throw new ArgumentException(
                    $"Config key \"{key}\" is declared in more than one tier ({existing} and {tier}). Each key must belong to exactly one tier.",
                    nameof(keys));
            }
            target[key] = tier;
        }
    }

    private static void AddKeysFromSection(JsonElement properties, string sectionName, HashSet<string> target)
    {
        if (!properties.TryGetProperty(sectionName, out var section) || section.ValueKind != JsonValueKind.Object) return;
        if (!section.TryGetProperty("properties", out var keys) || keys.ValueKind != JsonValueKind.Object) return;
        foreach (var prop in keys.EnumerateObject()) target.Add(prop.Name);
    }

    private static void AddKeysFromObject(JsonElement root, string objectName, HashSet<string> target)
    {
        if (!root.TryGetProperty(objectName, out var section) || section.ValueKind != JsonValueKind.Object) return;
        foreach (var prop in section.EnumerateObject()) target.Add(prop.Name);
    }
}

/// <summary>Which tier a container-schema key belongs to.</summary>
public enum ConfigKeyTier
{
    /// <summary>Public (client + server) value.</summary>
    Public,

    /// <summary>Secret (server-only) value.</summary>
    Secret,

    /// <summary>Feature-flag value.</summary>
    FeatureFlag,
}
