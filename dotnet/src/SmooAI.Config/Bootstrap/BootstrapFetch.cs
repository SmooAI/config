using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SmooAI.Config.Bootstrap;

/// <summary>
/// Lightweight cold-start config fetcher.
/// </summary>
/// <remarks>
/// <para>
/// This static class exists for callers that need to read a single
/// config value from a deploy script, container entry-point, or other
/// cold-start context where the full <see cref="SmooConfigClient"/>
/// SDK is too heavy or pulls in a transitive dependency that breaks
/// the host runtime.
/// </para>
/// <para>
/// It has zero dependencies on the rest of the SmooAI.Config SDK (no
/// logger, no fetch wrapper, no schema validation) and uses only
/// <c>System.Net.Http</c> + <c>System.Text.Json</c>.
/// </para>
/// <para>
/// It performs a single OAuth client_credentials exchange, then a
/// single GET against <c>/organizations/{orgId}/config/values</c> and
/// caches the values map per-process per-env so repeated reads inside
/// the same process avoid the round-trip.
/// </para>
/// <para>
/// Inputs (read from <see cref="Environment.GetEnvironmentVariable(string)"/>):
/// <list type="bullet">
///   <item><c>SMOOAI_CONFIG_API_URL</c> — base URL (default <c>https://api.smoo.ai</c>)</item>
///   <item><c>SMOOAI_CONFIG_AUTH_URL</c> — OAuth base URL (default <c>https://auth.smoo.ai</c>; legacy <c>SMOOAI_AUTH_URL</c> also accepted)</item>
///   <item><c>SMOOAI_CONFIG_CLIENT_ID</c> — OAuth M2M client id</item>
///   <item><c>SMOOAI_CONFIG_CLIENT_SECRET</c> — OAuth M2M client secret (legacy <c>SMOOAI_CONFIG_API_KEY</c> accepted)</item>
///   <item><c>SMOOAI_CONFIG_ORG_ID</c> — target org id</item>
///   <item><c>SMOOAI_CONFIG_ENV</c> — default env name (fallback when no SST stage detected)</item>
/// </list>
/// </para>
/// </remarks>
public static class Bootstrap
{
    private static readonly object CacheLock = new();
    private static string? _cachedEnv;
    private static Dictionary<string, JsonElement>? _cachedValues;

    private static readonly HttpClient DefaultClient = new();

    /// <summary>
    /// Fetch a single config value by camelCase key. Returns <c>null</c> if
    /// the key is not present in the values map; throws on env / auth /
    /// network failures.
    /// </summary>
    public static Task<string?> FetchAsync(
        string key,
        BootstrapOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        return FetchInternalAsync(key, options ?? new BootstrapOptions(), cancellationToken);
    }

    /// <summary>
    /// Test-only: clear the in-process cache. Not part of the supported
    /// public API.
    /// </summary>
    public static void ResetCache()
    {
        lock (CacheLock)
        {
            _cachedEnv = null;
            _cachedValues = null;
        }
    }

    internal static async Task<string?> FetchInternalAsync(
        string key,
        BootstrapOptions options,
        CancellationToken cancellationToken)
    {
        var getEnv = options.GetEnv ?? Environment.GetEnvironmentVariable;
        var httpClient = options.HttpClient ?? DefaultClient;

        var env = ResolveEnv(getEnv, options.Environment);

        Dictionary<string, JsonElement>? values;
        lock (CacheLock)
        {
            values = _cachedEnv == env ? _cachedValues : null;
        }

        if (values is null)
        {
            var creds = ReadCreds(getEnv);
            var token = await MintAccessTokenAsync(httpClient, creds, cancellationToken).ConfigureAwait(false);
            var fetched = await FetchValuesAsync(httpClient, creds, token, env, cancellationToken).ConfigureAwait(false);
            lock (CacheLock)
            {
                _cachedEnv = env;
                _cachedValues = fetched;
                values = fetched;
            }
        }

        if (!values.TryGetValue(key, out var element)) return null;
        return ElementToString(element);
    }

    internal static string ResolveEnv(Func<string, string?> getEnv, string? explicitEnv)
    {
        if (!string.IsNullOrEmpty(explicitEnv)) return explicitEnv;
        var stage = NonEmpty(getEnv("SST_STAGE")) ?? NonEmpty(getEnv("NEXT_PUBLIC_SST_STAGE"));
        if (stage is null)
        {
            var raw = NonEmpty(getEnv("SST_RESOURCE_App"));
            if (raw is not null)
            {
                try
                {
                    using var doc = JsonDocument.Parse(raw);
                    if (doc.RootElement.ValueKind == JsonValueKind.Object
                        && doc.RootElement.TryGetProperty("stage", out var s)
                        && s.ValueKind == JsonValueKind.String)
                    {
                        var parsed = s.GetString();
                        if (!string.IsNullOrEmpty(parsed)) stage = parsed;
                    }
                }
                catch (JsonException)
                {
                    // fall through
                }
            }
        }
        if (stage is null) return NonEmpty(getEnv("SMOOAI_CONFIG_ENV")) ?? "development";
        return stage == "production" ? "production" : stage;
    }

    private static string? NonEmpty(string? s) => string.IsNullOrEmpty(s) ? null : s;

    private static BootstrapCreds ReadCreds(Func<string, string?> getEnv)
    {
        var apiUrl = NonEmpty(getEnv("SMOOAI_CONFIG_API_URL")) ?? "https://api.smoo.ai";
        var authUrl = NonEmpty(getEnv("SMOOAI_CONFIG_AUTH_URL"))
                      ?? NonEmpty(getEnv("SMOOAI_AUTH_URL"))
                      ?? "https://auth.smoo.ai";
        var clientId = NonEmpty(getEnv("SMOOAI_CONFIG_CLIENT_ID"));
        var clientSecret = NonEmpty(getEnv("SMOOAI_CONFIG_CLIENT_SECRET"))
                           ?? NonEmpty(getEnv("SMOOAI_CONFIG_API_KEY"));
        var orgId = NonEmpty(getEnv("SMOOAI_CONFIG_ORG_ID"));

        if (clientId is null || clientSecret is null || orgId is null)
        {
            throw new BootstrapException(
                "[SmooAI.Config.Bootstrap] missing SMOOAI_CONFIG_{CLIENT_ID,CLIENT_SECRET,ORG_ID} in env. " +
                "Set these (e.g. via `pnpm sst shell --stage <stage>`) before calling FetchAsync.");
        }
        return new BootstrapCreds(apiUrl, authUrl, clientId, clientSecret, orgId);
    }

    private static async Task<string> MintAccessTokenAsync(
        HttpClient http,
        BootstrapCreds creds,
        CancellationToken cancellationToken)
    {
        var authUrl = creds.AuthUrl.TrimEnd('/') + "/token";
        var form = new FormUrlEncodedContent(new[]
        {
            new KeyValuePair<string, string>("grant_type", "client_credentials"),
            new KeyValuePair<string, string>("provider", "client_credentials"),
            new KeyValuePair<string, string>("client_id", creds.ClientId),
            new KeyValuePair<string, string>("client_secret", creds.ClientSecret),
        });
        using var req = new HttpRequestMessage(HttpMethod.Post, authUrl) { Content = form };
        using var resp = await http.SendAsync(req, cancellationToken).ConfigureAwait(false);
        var body = await SafeReadAsync(resp, cancellationToken).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
        {
            throw new BootstrapException(
                $"[SmooAI.Config.Bootstrap] OAuth token exchange failed: HTTP {(int)resp.StatusCode} {body}");
        }
        try
        {
            var parsed = JsonSerializer.Deserialize<TokenResponse>(body);
            var token = parsed?.AccessToken;
            if (string.IsNullOrEmpty(token))
            {
                throw new BootstrapException("[SmooAI.Config.Bootstrap] OAuth token endpoint returned no access_token");
            }
            return token;
        }
        catch (JsonException ex)
        {
            throw new BootstrapException($"[SmooAI.Config.Bootstrap] OAuth response not JSON: {ex.Message}", ex);
        }
    }

    private static async Task<Dictionary<string, JsonElement>> FetchValuesAsync(
        HttpClient http,
        BootstrapCreds creds,
        string token,
        string env,
        CancellationToken cancellationToken)
    {
        var apiBase = creds.ApiUrl.TrimEnd('/');
        var url = $"{apiBase}/organizations/{Uri.EscapeDataString(creds.OrgId)}/config/values?environment={Uri.EscapeDataString(env)}";
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        req.Headers.Accept.Add(new System.Net.Http.Headers.MediaTypeWithQualityHeaderValue("application/json"));

        using var resp = await http.SendAsync(req, cancellationToken).ConfigureAwait(false);
        var body = await SafeReadAsync(resp, cancellationToken).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
        {
            throw new BootstrapException(
                $"[SmooAI.Config.Bootstrap] GET /config/values failed: HTTP {(int)resp.StatusCode} {body}");
        }
        try
        {
            var parsed = JsonSerializer.Deserialize<ValuesResponse>(body);
            return parsed?.Values is not null
                ? new Dictionary<string, JsonElement>(parsed.Values)
                : new Dictionary<string, JsonElement>();
        }
        catch (JsonException ex)
        {
            throw new BootstrapException($"[SmooAI.Config.Bootstrap] values response not JSON: {ex.Message}", ex);
        }
    }

    private static async Task<string> SafeReadAsync(HttpResponseMessage resp, CancellationToken cancellationToken)
    {
        try { return await resp.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false); }
        catch { return string.Empty; }
    }

    private static string? ElementToString(JsonElement element)
    {
        return element.ValueKind switch
        {
            JsonValueKind.Null => null,
            JsonValueKind.Undefined => null,
            JsonValueKind.String => element.GetString(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            JsonValueKind.Number => element.GetRawText(),
            _ => element.GetRawText(),
        };
    }

    private sealed record BootstrapCreds(string ApiUrl, string AuthUrl, string ClientId, string ClientSecret, string OrgId);

    private sealed class TokenResponse
    {
        [JsonPropertyName("access_token")]
        public string? AccessToken { get; init; }
    }

    private sealed class ValuesResponse
    {
        [JsonPropertyName("values")]
        public Dictionary<string, JsonElement>? Values { get; init; }
    }
}

/// <summary>Options for <see cref="Bootstrap.FetchAsync"/>.</summary>
public sealed class BootstrapOptions
{
    /// <summary>Explicit environment name. Bypasses auto-detection when set.</summary>
    public string? Environment { get; set; }

    /// <summary>Override the HTTP client (mainly for tests).</summary>
    public HttpClient? HttpClient { get; set; }

    /// <summary>Override the env-lookup function (test-only).</summary>
    internal Func<string, string?>? GetEnv { get; set; }
}

/// <summary>Raised when <see cref="Bootstrap.FetchAsync"/> cannot complete.</summary>
public sealed class BootstrapException : Exception
{
    public BootstrapException(string message) : base(message) { }
    public BootstrapException(string message, Exception inner) : base(message, inner) { }
}
