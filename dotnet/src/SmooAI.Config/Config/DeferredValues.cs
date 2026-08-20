namespace SmooAI.Config.Config;

/// <summary>
/// Computes a config value from the merged config once every other value is known.
/// </summary>
/// <param name="config">A snapshot of the merged config, before any deferred value is resolved.</param>
/// <returns>The value to store under this key.</returns>
public delegate object? DeferredValue(IReadOnlyDictionary<string, object?> config);

/// <summary>
/// Resolves deferred config values against the merged config.
/// </summary>
/// <remarks>
/// Port of <c>go/config/deferred.go</c> / <c>rust/config/src/deferred.rs</c> /
/// <c>resolve_deferred_values</c> in the Python SDK. In TypeScript the same
/// feature is a function-valued entry in a config file, resolved by
/// <c>processConfigFileFeatures</c>.
/// </remarks>
public static class DeferredValues
{
    /// <summary>
    /// Resolve every deferred value against a single pre-resolution snapshot.
    /// </summary>
    /// <param name="config">The merged config, mutated in place with the resolved values.</param>
    /// <param name="deferred">The deferred resolvers, keyed by config key.</param>
    /// <remarks>
    /// Every resolver sees the SAME snapshot, never each other's output. That is
    /// what makes the result independent of dictionary iteration order — a
    /// resolver chain that could observe another resolver's result would produce
    /// different config on different runs.
    /// </remarks>
    public static void Resolve(IDictionary<string, object?> config, IReadOnlyDictionary<string, DeferredValue> deferred)
    {
        ArgumentNullException.ThrowIfNull(config);
        ArgumentNullException.ThrowIfNull(deferred);

        if (deferred.Count == 0) return;

        var snapshot = new Dictionary<string, object?>(config, StringComparer.Ordinal);

        foreach (var entry in deferred)
        {
            config[entry.Key] = entry.Value(snapshot);
        }
    }
}
