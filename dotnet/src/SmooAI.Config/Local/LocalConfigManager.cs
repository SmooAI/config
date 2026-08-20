using System.Text.Json;
using SmooAI.Config.Typed;

namespace SmooAI.Config.Local;

/// <summary>Construction options for <see cref="LocalConfigManager"/>.</summary>
public sealed class LocalConfigOptions
{
    /// <summary>Environment whose file defaults are read (<c>.smooai-config/&lt;environment&gt;.json</c>).</summary>
    public string Environment { get; init; } = "development";

    /// <summary>How long a resolved value stays cached. Defaults to 24 hours, matching the Go SDK.</summary>
    public TimeSpan CacheTtl { get; init; } = TimeSpan.FromHours(24);

    /// <summary>
    /// Environment override for tests. When null the process environment is read.
    /// </summary>
    public IReadOnlyDictionary<string, string?>? EnvOverride { get; init; }
}

/// <summary>
/// Lazy, cached, network-free config access from local file and environment tiers.
/// </summary>
/// <remarks>
/// <para>
/// Port of <c>go/config/local_config.go</c> (and the caching half of
/// <c>buildConfigAsync</c> in the TypeScript SDK). File tier takes precedence
/// over the environment tier, matching every other port.
/// </para>
/// <para>
/// Thread-safe. Each tier — public, secret, feature flag — keeps its own cache,
/// so a key can legitimately carry a different value per tier.
/// </para>
/// </remarks>
public sealed class LocalConfigManager
{
    private readonly record struct CacheEntry(JsonElement? Value, DateTimeOffset ExpiresAt);

    private readonly LocalConfigOptions _options;
    // Plain object, not System.Threading.Lock — this assembly still targets net8.0.
    private readonly object _gate = new();
    private readonly Dictionary<string, CacheEntry> _publicCache = new(StringComparer.Ordinal);
    private readonly Dictionary<string, CacheEntry> _secretCache = new(StringComparer.Ordinal);
    private readonly Dictionary<string, CacheEntry> _featureFlagCache = new(StringComparer.Ordinal);

    /// <summary>Create a manager with the default options.</summary>
    public LocalConfigManager()
        : this(new LocalConfigOptions())
    {
    }

    /// <summary>Create a manager.</summary>
    /// <param name="options">Environment, cache TTL, and an optional environment override for tests.</param>
    public LocalConfigManager(LocalConfigOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        _options = options;
    }

    /// <summary>Read a public config value.</summary>
    /// <param name="key">The config key, in camelCase.</param>
    /// <returns>The value, or null when no tier has it.</returns>
    public JsonElement? GetPublicConfig(string key) => GetValue(key, _publicCache);

    /// <summary>Read a secret config value.</summary>
    /// <param name="key">The config key, in camelCase.</param>
    /// <returns>The value, or null when no tier has it.</returns>
    public JsonElement? GetSecretConfig(string key) => GetValue(key, _secretCache);

    /// <summary>Read a feature flag value.</summary>
    /// <param name="key">The flag key, in camelCase.</param>
    /// <returns>The value, or null when no tier has it.</returns>
    public JsonElement? GetFeatureFlag(string key) => GetValue(key, _featureFlagCache);

    /// <summary>Drop every cached value so the next read re-reads the file and environment tiers.</summary>
    public void Invalidate()
    {
        lock (_gate)
        {
            _publicCache.Clear();
            _secretCache.Clear();
            _featureFlagCache.Clear();
        }
        EnvFileFallback.ResetFileCacheForTests();
    }

    private JsonElement? GetValue(string key, Dictionary<string, CacheEntry> cache)
    {
        // SMOODEV-847 — an empty key almost always means a typed-keys constant
        // was read for a key that is not in the schema. Say so, rather than
        // returning null and letting it surface as a confusing downstream error.
        if (string.IsNullOrEmpty(key))
        {
            throw new ArgumentException(
                "@smooai/config: get() called with empty key. " +
                "Most common cause: reading a typed-keys constant for a key that's not declared in your schema. " +
                "Add it to .smooai-config/config.ts and run `smoo config push`",
                nameof(key));
        }

        lock (_gate)
        {
            if (cache.TryGetValue(key, out var cached))
            {
                if (DateTimeOffset.UtcNow < cached.ExpiresAt) return cached.Value;
                cache.Remove(key);
            }

            // File tier wins over env, matching Go/TS.
            var value = EnvFileFallback.ReadFromFile(key, _options.Environment)
                ?? ReadFromEnv(key);

            cache[key] = new CacheEntry(value, DateTimeOffset.UtcNow.Add(_options.CacheTtl));
            return value;
        }
    }

    private JsonElement? ReadFromEnv(string key)
    {
        if (_options.EnvOverride is null) return EnvFileFallback.ReadFromEnv(key);

        var name = EnvFileFallback.EnvVarNameFor(key);
        if (!_options.EnvOverride.TryGetValue(name, out var raw) || string.IsNullOrEmpty(raw)) return null;

        try
        {
            using var document = JsonDocument.Parse(raw);
            return document.RootElement.Clone();
        }
        catch (JsonException)
        {
            return JsonSerializer.SerializeToElement(raw);
        }
    }
}
