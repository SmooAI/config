using System.Text.Json;
using SmooAI.Config.Models;
using SmooAI.Config.Runtime;

namespace SmooAI.Config.Typed;

/// <summary>
/// Strongly-typed handle to a config key. Emitted by the
/// <c>SmooAI.Config.SourceGenerator</c> from a <c>schema.json</c>, so mis-typed
/// keys fail at compile time instead of runtime.
/// </summary>
/// <typeparam name="T">Expected value type (<see cref="string"/>, <see cref="bool"/>, <see cref="double"/>, or a custom POCO).</typeparam>
public sealed class ConfigKey<T>
{
    /// <summary>Raw config key as stored server-side.</summary>
    public string Key { get; }

    /// <summary>Tier (<see cref="ConfigTier.Public"/> / <see cref="ConfigTier.Secret"/> / <see cref="ConfigTier.FeatureFlag"/>).</summary>
    public ConfigTier Tier { get; }

    /// <summary>Create a typed key. Normally called by generated code.</summary>
    public ConfigKey(string key, ConfigTier tier)
    {
        if (string.IsNullOrWhiteSpace(key)) throw new ArgumentException("@smooai/config: get() called with null/empty key. Most common cause: reading a typed-keys constant for a key that's not declared in your schema. Add it to .smooai-config/config.ts and run `smooai-config push`.", nameof(key));
        Key = key;
        Tier = tier;
    }

    /// <summary>Fetch the value from the live HTTP API.</summary>
    public async Task<T?> GetAsync(SmooConfigClient client, string? environment = null, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(client);
        var element = await client.GetValueAsync(Key, environment, cancellationToken).ConfigureAwait(false);
        return Deserialize(element);
    }

    /// <summary>
    /// Fetch the value from a local baked runtime. Returns <c>default</c>
    /// when the runtime is <c>null</c> or the key is absent.
    /// </summary>
    public T? Get(SmooConfigRuntime? runtime)
    {
        if (runtime is null) return default;
        var el = runtime.GetValue(Key);
        return el.HasValue ? Deserialize(el.Value) : default;
    }

    /// <summary>
    /// Resolve from a runtime when baked, else fall back to the HTTP client.
    /// This is the typical production pattern: public + secret come from the
    /// baked blob synchronously; everything else (feature flags, missing keys)
    /// falls through to the network.
    /// </summary>
    public async Task<T?> ResolveAsync(
        SmooConfigRuntime? runtime,
        SmooConfigClient client,
        string? environment = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(client);

        if (runtime is not null)
        {
            var el = runtime.GetValue(Key);
            if (el.HasValue) return Deserialize(el.Value);
        }

        return await GetAsync(client, environment, cancellationToken).ConfigureAwait(false);
    }

    private static T? Deserialize(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Undefined || element.ValueKind == JsonValueKind.Null)
        {
            return default;
        }

        // Fast path for primitive generics — JsonElement.Deserialize<string>()
        // on a string-valued element works correctly.
        return element.Deserialize<T>(SmooConfigClient.JsonOptions);
    }

    /// <inheritdoc />
    public override string ToString() => $"ConfigKey<{typeof(T).Name}>({Key}, {Tier})";
}
