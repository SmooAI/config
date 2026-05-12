using System.Text.Json;

namespace SmooAI.Config.Typed;

/// <summary>
/// SMOODEV-957 — env-var + local-file fallback helpers for
/// <see cref="ConfigKey{T}.ResolveAsync"/>. Mirrors the priority chain TS /
/// Python / Rust / Go already ship (bake → env → http → file) so the .NET SDK
/// reaches parity.
/// </summary>
/// <remarks>
/// <para>
/// Env-var names follow the same convention as the other ports: the config
/// key in camelCase is rewritten to <c>SMOOAI_CONFIG_&lt;UPPER_SNAKE&gt;</c>.
/// Example: <c>moonshotApiKey</c> → <c>SMOOAI_CONFIG_MOONSHOT_API_KEY</c>.
/// </para>
/// <para>
/// File-tier defaults live in <c>.smooai-config/&lt;env&gt;.json</c> under the
/// current working directory, or in the directory pointed at by
/// <c>SMOOAI_CONFIG_FILE_DIR</c>. The file is treated as a flat JSON object;
/// values are parsed as <see cref="JsonElement"/> and deserialized via the
/// same path <see cref="SmooConfigClient.JsonOptions"/> uses.
/// </para>
/// </remarks>
internal static class EnvFileFallback
{
    /// <summary>Environment variable prefix for the env-var fallback tier.</summary>
    internal const string EnvVarPrefix = "SMOOAI_CONFIG_";

    /// <summary>Optional override pointing at the file-defaults directory.</summary>
    internal const string FileDirEnvVar = "SMOOAI_CONFIG_FILE_DIR";

    private const string DefaultDir = ".smooai-config";

    // File-defaults cache. Keyed by (resolved-dir, environment) so the same
    // process can resolve multiple stages cheaply.
    private static readonly Dictionary<string, JsonElement> s_fileCache =
        new(StringComparer.Ordinal);
    private static readonly object s_fileCacheLock = new();

    /// <summary>
    /// Convert camelCase to UPPER_SNAKE_CASE and prepend the env-var prefix.
    /// Already-upper-snake keys are returned untouched (after prefix).
    /// </summary>
    internal static string EnvVarNameFor(string key)
    {
        // Fast path: already UPPER_SNAKE_CASE.
        if (IsUpperSnake(key)) return EnvVarPrefix + key;

        var sb = new System.Text.StringBuilder(key.Length + 8);
        sb.Append(EnvVarPrefix);
        for (int i = 0; i < key.Length; i++)
        {
            var c = key[i];
            if (char.IsUpper(c) && i > 0) sb.Append('_');
            sb.Append(char.ToUpperInvariant(c));
        }
        return sb.ToString();
    }

    private static bool IsUpperSnake(string s)
    {
        if (string.IsNullOrEmpty(s)) return false;
        foreach (var c in s)
        {
            if (!(char.IsUpper(c) || char.IsDigit(c) || c == '_')) return false;
        }
        return true;
    }

    /// <summary>
    /// Read the env-var tier. Returns <c>null</c> when the var is unset or
    /// empty. JSON-shaped values are parsed as JSON; anything else is wrapped
    /// as a JSON string so callers get a uniform <see cref="JsonElement"/>.
    /// </summary>
    internal static JsonElement? ReadFromEnv(string key)
    {
        var raw = Environment.GetEnvironmentVariable(EnvVarNameFor(key));
        if (string.IsNullOrEmpty(raw)) return null;

        // Try JSON first so booleans / numbers / objects round-trip; fall
        // back to a JSON string so the deserializer downstream can handle
        // primitives without a separate coercion path.
        try
        {
            using var doc = JsonDocument.Parse(raw);
            return doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            return JsonSerializer.SerializeToElement(raw);
        }
    }

    /// <summary>
    /// Read the file-tier defaults for <paramref name="environment"/>. Returns
    /// <c>null</c> when no file exists, the env override points at a missing
    /// directory, or the file is malformed.
    /// </summary>
    internal static JsonElement? ReadFromFile(string key, string environment)
    {
        var dir = Environment.GetEnvironmentVariable(FileDirEnvVar);
        if (string.IsNullOrWhiteSpace(dir))
        {
            dir = Path.Combine(Directory.GetCurrentDirectory(), DefaultDir);
        }

        var path = Path.Combine(dir, $"{environment}.json");

        JsonElement root;
        var cacheKey = path; // resolved file path keys the cache
        lock (s_fileCacheLock)
        {
            if (s_fileCache.TryGetValue(cacheKey, out var cached))
            {
                root = cached;
            }
            else
            {
                if (!File.Exists(path)) return null;

                try
                {
                    var bytes = File.ReadAllBytes(path);
                    using var doc = JsonDocument.Parse(bytes);
                    root = doc.RootElement.Clone();
                    s_fileCache[cacheKey] = root;
                }
                catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
                {
                    // File-tier is best-effort — a malformed defaults file
                    // shouldn't crash an otherwise-working app. The other
                    // language ports follow the same posture (graceful
                    // fall-through).
                    return null;
                }
            }
        }

        if (root.ValueKind != JsonValueKind.Object) return null;
        return root.TryGetProperty(key, out var value) ? value : null;
    }

    /// <summary>Test seam — clear the in-process file cache.</summary>
    internal static void ResetFileCacheForTests()
    {
        lock (s_fileCacheLock)
        {
            s_fileCache.Clear();
        }
    }
}
