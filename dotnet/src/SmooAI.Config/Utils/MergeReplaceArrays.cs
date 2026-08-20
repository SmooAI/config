namespace SmooAI.Config.Utils;

/// <summary>
/// Deep merge where arrays REPLACE rather than concatenate.
/// </summary>
/// <remarks>
/// Port of <c>src/utils/mergeReplaceArrays.ts</c> and <c>go/config/merge.go</c>.
/// Array-replace is the whole point: config layers express "the list is now
/// exactly this", so concatenating a base list with an override would silently
/// resurrect entries the override meant to drop.
/// </remarks>
public static class MergeReplaceArrays
{
    /// <summary>
    /// Merge <paramref name="source"/> over <paramref name="target"/>.
    /// </summary>
    /// <param name="target">The base value.</param>
    /// <param name="source">The overriding value.</param>
    /// <returns>
    /// A new value: lists from <paramref name="source"/> replace outright,
    /// dictionaries merge recursively, everything else is overwritten.
    /// Neither input is mutated.
    /// </returns>
    public static object? Merge(object? target, object? source)
    {
        // string is not an IReadOnlyList<object?>, so it falls through to the
        // primitive branch rather than merging as a list of characters.
        if (source is IReadOnlyList<object?> sourceList)
        {
            return sourceList.ToList();
        }

        if (source is IReadOnlyDictionary<string, object?> sourceDictionary)
        {
            var merged = target is IReadOnlyDictionary<string, object?> targetDictionary
                ? new Dictionary<string, object?>(targetDictionary.ToDictionary(entry => entry.Key, entry => entry.Value), StringComparer.Ordinal)
                : new Dictionary<string, object?>(StringComparer.Ordinal);

            foreach (var entry in sourceDictionary)
            {
                merged[entry.Key] = merged.TryGetValue(entry.Key, out var existing)
                    ? Merge(existing, entry.Value)
                    : entry.Value;
            }

            return merged;
        }

        return source;
    }
}
