using System.Text.Json;

namespace SmooAI.Config.Runtime;

/// <summary>
/// Decrypted <c>{public, secret}</c> partition from a baked blob. Feature
/// flags are never baked (they stay live-fetched), so this shape only ever
/// carries public + secret keys.
/// </summary>
public sealed class BakedConfig
{
    /// <summary>Public (non-sensitive) values. Empty when not baked.</summary>
    public IReadOnlyDictionary<string, JsonElement> Public { get; }

    /// <summary>Secret values. Empty when not baked.</summary>
    public IReadOnlyDictionary<string, JsonElement> Secret { get; }

    internal BakedConfig(
        IReadOnlyDictionary<string, JsonElement> publicValues,
        IReadOnlyDictionary<string, JsonElement> secretValues)
    {
        Public = publicValues;
        Secret = secretValues;
    }

    /// <summary>True when both partitions are empty.</summary>
    public bool IsEmpty => Public.Count == 0 && Secret.Count == 0;

    /// <summary>Total number of baked entries (public + secret).</summary>
    public int Count => Public.Count + Secret.Count;

    /// <summary>
    /// Merged <c>{public, secret}</c> view. Secret wins on collisions —
    /// matches the TS / Python / Rust / Go hydrator semantics.
    /// </summary>
    public IReadOnlyDictionary<string, JsonElement> Merged
    {
        get
        {
            var merged = new Dictionary<string, JsonElement>(Public.Count + Secret.Count, StringComparer.Ordinal);
            foreach (var (k, v) in Public) merged[k] = v;
            foreach (var (k, v) in Secret) merged[k] = v;
            return merged;
        }
    }
}
