using System.Collections.Concurrent;
using System.Text.Json;

namespace SmooAI.Config.Container;

/// <summary>
/// The handle returned by <see cref="ContainerConfig.InitContainerConfigAsync"/>.
/// Exposes the same tier accessors as the default chain (async
/// <c>GetAsync</c> + sync <c>GetSync</c>) but with spec §3 fail-loud behavior,
/// plus a non-throwing <see cref="Health"/> for Kubernetes readiness/liveness
/// probes.
/// </summary>
public sealed class ContainerConfigHandle
{
    private readonly SmooConfigClient _client;
    private readonly ContainerConfigSchema _schema;
    private readonly string _environment;
    private readonly TimeSpan _cacheTtl;
    private readonly HashSet<string> _optionalKeys;
    private readonly Func<string, string?> _getEnv;

    // Per-key value cache (the dotnet SmooConfigClient has no value cache of its
    // own; we mirror the TS ConfigClient's seedCache/getCachedValue/TTL here).
    private readonly ConcurrentDictionary<string, CacheEntry> _cache = new(StringComparer.Ordinal);

    // Health state (spec §5): once an initial fetch succeeds we serve last-good
    // on a later background refresh failure until the cache TTL hard-expires.
    private readonly object _healthLock = new();
    private bool _lastFetchOk;
    private DateTimeOffset _lastFetchAt;
    private string? _lastError;

    /// <summary>Clock seam for TTL/expiry checks. Swap in tests.</summary>
    internal Func<DateTimeOffset> UtcNow { get; set; } = () => DateTimeOffset.UtcNow;

    /// <summary>Public (client + server) config tier accessor.</summary>
    public ConfigTierAccessor PublicConfig { get; }

    /// <summary>Secret (server-only) config tier accessor.</summary>
    public ConfigTierAccessor SecretConfig { get; }

    /// <summary>Feature-flag tier accessor.</summary>
    public ConfigTierAccessor FeatureFlag { get; }

    /// <summary>
    /// The underlying <see cref="SmooConfigClient"/> (escape hatch for advanced
    /// callers; e.g. segment-aware feature-flag evaluation).
    /// </summary>
    public SmooConfigClient Client => _client;

    internal ContainerConfigHandle(
        SmooConfigClient client,
        ContainerConfigSchema schema,
        string environment,
        TimeSpan cacheTtl,
        IReadOnlyList<string>? optionalKeys,
        Func<string, string?> getEnv)
    {
        _client = client;
        _schema = schema;
        _environment = environment;
        _cacheTtl = cacheTtl;
        _optionalKeys = new HashSet<string>(optionalKeys ?? Array.Empty<string>(), StringComparer.Ordinal);
        _getEnv = getEnv;

        PublicConfig = new ConfigTierAccessor(this, ConfigKeyTier.Public);
        SecretConfig = new ConfigTierAccessor(this, ConfigKeyTier.Secret);
        FeatureFlag = new ConfigTierAccessor(this, ConfigKeyTier.FeatureFlag);
    }

    /// <summary>
    /// Initial fetch-all-values — primes the cache and the health state at
    /// startup. Throws on auth/network failure so bootstrap fails loud (spec §4).
    /// </summary>
    internal async Task PrimeAsync(CancellationToken cancellationToken)
    {
        try
        {
            var all = await _client.GetAllValuesAsync(_environment, cancellationToken).ConfigureAwait(false);
            var now = UtcNow();
            foreach (var (key, value) in all)
            {
                _cache[key] = new CacheEntry(value, now);
            }
            MarkFetchOk(now);
        }
        catch (Exception ex)
        {
            lock (_healthLock) { _lastError = ex.Message; }
            throw;
        }
    }

    /// <summary>
    /// Cheap, non-throwing status for readiness/liveness probes (spec §4).
    /// Serves <c>healthy</c> while within the cache TTL of the last good fetch
    /// even if a background refresh just failed; past the hard TTL, a failed
    /// refresh flips to <c>unhealthy</c> (spec §5).
    /// </summary>
    public ConfigHealth Health()
    {
        lock (_healthLock)
        {
            if (!_lastFetchOk)
            {
                return ConfigHealth.Unhealthy(_lastError ?? "initial config fetch has not succeeded");
            }
            var age = UtcNow() - _lastFetchAt;
            if (_lastError is not null && age > _cacheTtl)
            {
                return ConfigHealth.Unhealthy(
                    $"last config refresh failed and cache TTL ({_cacheTtl.TotalMilliseconds}ms) expired: {_lastError}");
            }
            return ConfigHealth.Healthy();
        }
    }

    private void MarkFetchOk(DateTimeOffset at)
    {
        lock (_healthLock)
        {
            _lastFetchOk = true;
            _lastFetchAt = at;
            _lastError = null;
        }
    }

    private bool IsOptional(string key) => _optionalKeys.Contains(key);

    /// <summary>
    /// Async tier read for a single key. Order matches the existing chain's
    /// env-over-http precedence: an explicitly-set process env var wins, else
    /// the HTTP (config server) value. Blob/file tiers are disabled (spec §2).
    /// </summary>
    private async Task<ResolveResult> ResolveAsync(string key, CancellationToken cancellationToken)
    {
        var tried = new List<string> { ResolutionTier.Env.ToWireString() };

        var fromEnv = ContainerConfig.NonBlank(_getEnv(ContainerConfig.EnvVarNameFor(key)));
        if (fromEnv is not null)
        {
            // Seed the cache so a later GetSync sees the env override too.
            _cache[key] = new CacheEntry(JsonValueFromString(fromEnv), UtcNow());
            return new ResolveResult(fromEnv, tried);
        }

        tried.Add(ResolutionTier.Http.ToWireString());
        var entry = GetFreshCacheEntry(key);
        if (entry is not null)
        {
            // Cache hit within TTL — no HTTP round-trip (matches TS, where the
            // initial getAllValues seeds the cache so subsequent reads are free).
            var cachedValue = ElementToValue(entry.Value);
            if (cachedValue is not null) return new ResolveResult(cachedValue, tried);
            return new ResolveResult(null, tried);
        }

        try
        {
            var element = await _client.GetValueAsync(key, _environment, cancellationToken).ConfigureAwait(false);
            var now = UtcNow();
            _cache[key] = new CacheEntry(element, now);
            MarkFetchOk(now);
            var value = ElementToValue(element);
            return new ResolveResult(value, tried);
        }
        catch (Exception ex)
        {
            lock (_healthLock) { _lastError = ex.Message; }
            // §5: serve last-good from cache until the TTL hard-expires. Past
            // hard-expiry GetFreshCacheEntry returns null, so the read resolves
            // absent and a required key fails loud (matches the TS contract).
            var staleEntry = GetFreshCacheEntry(key);
            var stale = staleEntry is not null ? ElementToValue(staleEntry.Value) : null;
            if (stale is not null) return new ResolveResult(stale, tried);
            return new ResolveResult(null, tried);
        }
    }

    /// <summary>Sync tier read — env override, else last cached HTTP value.</summary>
    private ResolveResult SyncResolve(string key)
    {
        var tried = new List<string> { ResolutionTier.Env.ToWireString() };

        var fromEnv = ContainerConfig.NonBlank(_getEnv(ContainerConfig.EnvVarNameFor(key)));
        if (fromEnv is not null) return new ResolveResult(fromEnv, tried);

        tried.Add(ResolutionTier.Http.ToWireString());
        var entry = GetFreshCacheEntry(key);
        var value = entry is not null ? ElementToValue(entry.Value) : null;
        return new ResolveResult(value, tried);
    }

    private CacheEntry? GetFreshCacheEntry(string key)
    {
        if (!_cache.TryGetValue(key, out var entry)) return null;
        if (UtcNow() - entry.FetchedAt > _cacheTtl) return null; // TTL hard-expired.
        return entry;
    }

    private void AssertKey(string? key, ConfigKeyTier tier)
    {
        if (string.IsNullOrWhiteSpace(key))
        {
            throw new ArgumentException(
                $"SmooAI.Config (container): {tier}Config called with a null/empty key.",
                nameof(key));
        }
        if (!_schema.ContainsInTier(key!, tier))
        {
            throw new ArgumentException(
                $"SmooAI.Config (container): key \"{key}\" is not declared as a {tier} key in the schema. " +
                $"Add it to your schema (or read it via the correct tier accessor).",
                nameof(key));
        }
    }

    private async Task<object?> GetAsyncCore(string key, ConfigKeyTier tier, CancellationToken cancellationToken)
    {
        AssertKey(key, tier);
        var result = await ResolveAsync(key, cancellationToken).ConfigureAwait(false);
        if (result.Value is not null) return result.Value;
        if (IsOptional(key)) return null;
        throw new ConfigKeyUnresolvedException(key, _environment, result.TriedTiers);
    }

    private object? GetSyncCore(string key, ConfigKeyTier tier)
    {
        AssertKey(key, tier);
        var result = SyncResolve(key);
        if (result.Value is not null) return result.Value;
        if (IsOptional(key)) return null;
        throw new ConfigKeyUnresolvedException(key, _environment, result.TriedTiers);
    }

    private async Task<T?> GetTypedAsync<T>(string key, ConfigKeyTier tier, CancellationToken cancellationToken)
    {
        var value = await GetAsyncCore(key, tier, cancellationToken).ConfigureAwait(false);
        return Coerce<T>(value);
    }

    private T? GetTypedSync<T>(string key, ConfigKeyTier tier)
    {
        var value = GetSyncCore(key, tier);
        return Coerce<T>(value);
    }

    private static T? Coerce<T>(object? value)
    {
        if (value is null) return default;
        if (value is T typed) return typed;
        if (value is JsonElement el) return el.Deserialize<T>(SmooConfigClient.JsonOptions);
        if (value is string s)
        {
            if (typeof(T) == typeof(string)) return (T)(object)s;
            // Try JSON-deserialize the raw string (e.g. a number or bool came
            // from an env override). Fall back to ChangeType for primitives.
            try { return JsonSerializer.Deserialize<T>(s, SmooConfigClient.JsonOptions); }
            catch (JsonException) { return (T)Convert.ChangeType(s, typeof(T)); }
        }
        return (T)Convert.ChangeType(value, typeof(T));
    }

    /// <summary>
    /// Convert a server <see cref="JsonElement"/> to a CLR value, returning
    /// <c>null</c> for absent (Null/Undefined). Strings unwrap to
    /// <see cref="string"/>; everything else stays a <see cref="JsonElement"/>.
    /// </summary>
    private static object? ElementToValue(JsonElement element)
    {
        return element.ValueKind switch
        {
            JsonValueKind.Null or JsonValueKind.Undefined => null,
            JsonValueKind.String => element.GetString(),
            _ => element,
        };
    }

    private static JsonElement JsonValueFromString(string value)
    {
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(value));
        return doc.RootElement.Clone();
    }

    private sealed record CacheEntry(JsonElement Value, DateTimeOffset FetchedAt);

    private sealed record ResolveResult(object? Value, IReadOnlyList<string> TriedTiers);

    /// <summary>
    /// Tier-scoped accessor exposing fail-loud <c>GetAsync</c>/<c>GetSync</c>
    /// reads. Both the typed and untyped overloads throw
    /// <see cref="ConfigKeyUnresolvedException"/> for a required key that
    /// resolves absent (spec §3); optional keys return <c>null</c>/<c>default</c>.
    /// </summary>
    public sealed class ConfigTierAccessor
    {
        private readonly ContainerConfigHandle _handle;
        private readonly ConfigKeyTier _tier;

        internal ConfigTierAccessor(ContainerConfigHandle handle, ConfigKeyTier tier)
        {
            _handle = handle;
            _tier = tier;
        }

        /// <summary>
        /// Resolve <paramref name="key"/> as a string (the common case for
        /// secrets and URLs). Fail-loud (spec §3).
        /// </summary>
        public async Task<string?> GetAsync(string key, CancellationToken cancellationToken = default)
        {
            var value = await _handle.GetAsyncCore(key, _tier, cancellationToken).ConfigureAwait(false);
            return value switch
            {
                null => null,
                string s => s,
                JsonElement el => ElementToValue(el) as string ?? el.GetRawText(),
                _ => value.ToString(),
            };
        }

        /// <summary>Synchronous string read (spec §3 fail-loud).</summary>
        public string? GetSync(string key)
        {
            var value = _handle.GetSyncCore(key, _tier);
            return value switch
            {
                null => null,
                string s => s,
                JsonElement el => ElementToValue(el) as string ?? el.GetRawText(),
                _ => value.ToString(),
            };
        }

        /// <summary>
        /// Resolve <paramref name="key"/> deserialized into
        /// <typeparamref name="T"/>. Fail-loud (spec §3).
        /// </summary>
        public Task<T?> GetAsync<T>(string key, CancellationToken cancellationToken = default)
            => _handle.GetTypedAsync<T>(key, _tier, cancellationToken);

        /// <summary>Synchronous typed read (spec §3 fail-loud).</summary>
        public T? GetSync<T>(string key) => _handle.GetTypedSync<T>(key, _tier);
    }
}
