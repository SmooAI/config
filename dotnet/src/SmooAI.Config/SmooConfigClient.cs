using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using SmooAI.Config.Models;
using SmooAI.Config.OAuth;

namespace SmooAI.Config;

/// <summary>
/// HTTP client for the Smoo AI config platform. Authenticates via OAuth2
/// client-credentials (<c>auth.smoo.ai/token</c>) and talks to the config
/// REST API (<c>api.smoo.ai/organizations/{org_id}/config/...</c>).
/// </summary>
/// <remarks>
/// Phase 1 surface: GetValue, GetAllValues, SetValue. The cohort-aware
/// evaluator and buildBundle / buildConfigRuntime helpers land in later
/// phases (SMOODEV-657 follow-ups).
/// </remarks>
public sealed class SmooConfigClient : IDisposable
{
    private readonly HttpClient _httpClient;
    private readonly TokenProvider _tokenProvider;
    private readonly bool _disposeHttpClient;
    private readonly string _baseUrl;
    private readonly string _orgId;
    private readonly string _defaultEnvironment;

    /// <summary>JSON options used for both request and response bodies.</summary>
    public static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>
    /// Create a client. When <paramref name="httpClient"/> is null a new
    /// <see cref="HttpClient"/> is created and disposed with this instance.
    /// Callers using <c>IHttpClientFactory</c> should pass a typed client
    /// in via the overload that accepts <see cref="TokenProvider"/>.
    /// </summary>
    public SmooConfigClient(SmooConfigClientOptions options, HttpClient? httpClient = null)
    {
        ArgumentNullException.ThrowIfNull(options);
        options.Validate();

        _baseUrl = options.BaseUrl.TrimEnd('/');
        _orgId = options.OrgId;
        _defaultEnvironment = options.DefaultEnvironment;

        if (httpClient is null)
        {
            _httpClient = new HttpClient();
            _disposeHttpClient = true;
        }
        else
        {
            _httpClient = httpClient;
            _disposeHttpClient = false;
        }

        var authUrl = string.IsNullOrWhiteSpace(options.AuthUrl)
            ? SmooConfigClientOptions.DeriveAuthUrl(options.BaseUrl)
            : options.AuthUrl!;

        _tokenProvider = new TokenProvider(_httpClient, authUrl, options.ClientId, options.ClientSecret, options.TokenRefreshWindow);
    }

    /// <summary>
    /// Test / DI seam — inject a pre-built <see cref="TokenProvider"/> so
    /// callers can stub it without hitting the auth server.
    /// </summary>
    internal SmooConfigClient(SmooConfigClientOptions options, HttpClient httpClient, TokenProvider tokenProvider)
    {
        ArgumentNullException.ThrowIfNull(options);
        options.Validate();

        _baseUrl = options.BaseUrl.TrimEnd('/');
        _orgId = options.OrgId;
        _defaultEnvironment = options.DefaultEnvironment;
        _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
        _tokenProvider = tokenProvider ?? throw new ArgumentNullException(nameof(tokenProvider));
        _disposeHttpClient = false;
    }

    /// <summary>Invalidate the cached OAuth token so the next call re-exchanges.</summary>
    public void InvalidateToken() => _tokenProvider.Invalidate();

    /// <summary>
    /// Get a single config value. Returns a <see cref="JsonElement"/> so
    /// callers can deserialize into whatever type their schema defines.
    /// </summary>
    /// <param name="key">Config key.</param>
    /// <param name="environment">Environment name; falls back to <c>DefaultEnvironment</c>.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    public async Task<JsonElement> GetValueAsync(string key, string? environment = null, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(key)) throw new ArgumentException("@smooai/config: get() called with null/empty key. Most common cause: reading a typed-keys constant for a key that's not declared in your schema. Add it to .smooai-config/config.ts and run `smooai-config push`.", nameof(key));
        var env = ResolveEnv(environment);

        var url = $"{_baseUrl}/organizations/{_orgId}/config/values/{Uri.EscapeDataString(key)}?environment={Uri.EscapeDataString(env)}";
        var wrapper = await SendWithRetryAsync<ConfigValueResponse>(HttpMethod.Get, url, null, cancellationToken).ConfigureAwait(false);
        return wrapper?.Value ?? default;
    }

    /// <summary>Get all config values for an environment.</summary>
    public async Task<Dictionary<string, JsonElement>> GetAllValuesAsync(string? environment = null, CancellationToken cancellationToken = default)
    {
        var env = ResolveEnv(environment);
        var url = $"{_baseUrl}/organizations/{_orgId}/config/values?environment={Uri.EscapeDataString(env)}";
        var result = await SendWithRetryAsync<ConfigValuesResponse>(HttpMethod.Get, url, null, cancellationToken).ConfigureAwait(false);

        if (result is null) return new Dictionary<string, JsonElement>();
        if (result.Success == false)
        {
            throw new SmooConfigApiException(
                $"API error: {result.Error ?? "unknown error returned by values endpoint"}",
                statusCode: (int)HttpStatusCode.OK);
        }
        return result.Values ?? new Dictionary<string, JsonElement>();
    }

    /// <summary>
    /// Set a config value. The server requires both <paramref name="schemaId"/>
    /// and <paramref name="environmentId"/> (UUIDs). Callers that only have
    /// a name can resolve these via the schemas/environments endpoints — a
    /// higher-level helper will land in a later phase.
    /// </summary>
    public Task SetValueAsync(
        string schemaId,
        string environmentId,
        string key,
        object? value,
        ConfigTier tier,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(schemaId)) throw new ArgumentException("SchemaId is required.", nameof(schemaId));
        if (string.IsNullOrWhiteSpace(environmentId)) throw new ArgumentException("EnvironmentId is required.", nameof(environmentId));
        if (string.IsNullOrWhiteSpace(key)) throw new ArgumentException("@smooai/config: get() called with null/empty key. Most common cause: reading a typed-keys constant for a key that's not declared in your schema. Add it to .smooai-config/config.ts and run `smooai-config push`.", nameof(key));

        var body = new SetValueRequest
        {
            SchemaId = schemaId,
            EnvironmentId = environmentId,
            Key = key,
            Value = value,
            Tier = tier.ToWireString(),
        };

        var url = $"{_baseUrl}/organizations/{_orgId}/config/values";
        return SendWithRetryAsync<JsonElement>(HttpMethod.Put, url, body, cancellationToken);
    }

    /// <summary>
    /// Evaluate a segment-aware feature flag against the server. SMOODEV-959 —
    /// brings the .NET SDK to parity with TS / Python / Rust / Go.
    /// </summary>
    /// <remarks>
    /// Unlike <see cref="GetValueAsync"/>, this is always a network call:
    /// segment rules (percentage rollout, attribute matching, bucketing) live
    /// server-side and the response depends on the <paramref name="context"/>
    /// you pass. Callers that don't need segment evaluation should keep using
    /// <see cref="GetValueAsync"/> for the static flag value.
    /// </remarks>
    /// <param name="key">Feature-flag key.</param>
    /// <param name="context">Attributes the server's segment rules may reference
    /// (e.g. <c>{ userId, tenantId, plan, country }</c>). Unreferenced keys are
    /// ignored by the server. Keep values JSON-serializable — the server hashes
    /// <c>bucketBy</c> values by their string representation, so numbers and
    /// booleans bucket stably across client rebuilds. A null map is sent as <c>{}</c>.</param>
    /// <param name="environment">Environment name; falls back to <c>DefaultEnvironment</c>.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <exception cref="FeatureFlagEvaluationException">Thrown on any non-2xx response. Inspect <see cref="FeatureFlagEvaluationException.Kind"/> for 404 / 400 / 5xx.</exception>
    public async Task<EvaluateFeatureFlagResponse> EvaluateFeatureFlagAsync(
        string key,
        IReadOnlyDictionary<string, object?>? context = null,
        string? environment = null,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(key))
        {
            throw new ArgumentException(
                "@smooai/config: EvaluateFeatureFlag called with null/empty key. " +
                "Most common cause: reading a typed-keys constant for a key that's not declared in your schema. " +
                "Add it to .smooai-config/config.ts and run `smooai-config push`.",
                nameof(key));
        }

        var env = ResolveEnv(environment);
        var body = new EvaluateFeatureFlagRequest
        {
            Environment = env,
            Context = context ?? new Dictionary<string, object?>(),
        };

        var url = $"{_baseUrl}/organizations/{_orgId}/config/feature-flags/{Uri.EscapeDataString(key)}/evaluate";

        // We can't reuse SendWithRetryAsync because we need to map status
        // codes to the typed FeatureFlagEvaluationException categories before
        // it converts everything to SmooConfigApiException.
        var response = await SendOnceAsync(HttpMethod.Post, url, body, cancellationToken).ConfigureAwait(false);
        try
        {
            if (response.StatusCode == HttpStatusCode.Unauthorized)
            {
                response.Dispose();
                _tokenProvider.Invalidate();
                response = await SendOnceAsync(HttpMethod.Post, url, body, cancellationToken).ConfigureAwait(false);
            }

            if (!response.IsSuccessStatusCode)
            {
                var text = await SafeReadAsync(response, cancellationToken).ConfigureAwait(false);
                var kind = response.StatusCode switch
                {
                    HttpStatusCode.NotFound => FeatureFlagErrorKind.NotFound,
                    HttpStatusCode.BadRequest => FeatureFlagErrorKind.Context,
                    _ => FeatureFlagErrorKind.Server,
                };
                throw new FeatureFlagEvaluationException(key, (int)response.StatusCode, kind, string.IsNullOrWhiteSpace(text) ? null : text.Trim());
            }

            var result = await response.Content.ReadFromJsonAsync<EvaluateFeatureFlagResponse>(JsonOptions, cancellationToken).ConfigureAwait(false);
            return result ?? new EvaluateFeatureFlagResponse();
        }
        finally
        {
            response.Dispose();
        }
    }

    private string ResolveEnv(string? environment)
        => string.IsNullOrWhiteSpace(environment) ? _defaultEnvironment : environment!;

    private async Task<T?> SendWithRetryAsync<T>(HttpMethod method, string url, object? body, CancellationToken cancellationToken)
    {
        // Try once with the current token; on a 401 invalidate + retry once.
        var response = await SendOnceAsync(method, url, body, cancellationToken).ConfigureAwait(false);
        try
        {
            if (response.StatusCode == HttpStatusCode.Unauthorized)
            {
                response.Dispose();
                _tokenProvider.Invalidate();
                response = await SendOnceAsync(method, url, body, cancellationToken).ConfigureAwait(false);
            }

            if (!response.IsSuccessStatusCode)
            {
                var text = await SafeReadAsync(response, cancellationToken).ConfigureAwait(false);
                throw new SmooConfigApiException(
                    $"Config API error: HTTP {(int)response.StatusCode} {response.ReasonPhrase}{(string.IsNullOrEmpty(text) ? string.Empty : $" — {text}")}.",
                    statusCode: (int)response.StatusCode);
            }

            if (response.Content.Headers.ContentLength == 0) return default;
            return await response.Content.ReadFromJsonAsync<T>(JsonOptions, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            response.Dispose();
        }
    }

    private async Task<HttpResponseMessage> SendOnceAsync(HttpMethod method, string url, object? body, CancellationToken cancellationToken)
    {
        var token = await _tokenProvider.GetAccessTokenAsync(cancellationToken).ConfigureAwait(false);
        using var request = new HttpRequestMessage(method, url);
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body, options: JsonOptions);
        }
        return await _httpClient.SendAsync(request, HttpCompletionOption.ResponseContentRead, cancellationToken).ConfigureAwait(false);
    }

    private static async Task<string> SafeReadAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        try { return await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false); }
        catch { return string.Empty; }
    }

    public void Dispose()
    {
        if (_disposeHttpClient) _httpClient.Dispose();
    }

    private sealed class EvaluateFeatureFlagRequest
    {
        [JsonPropertyName("environment")]
        public string Environment { get; init; } = string.Empty;

        [JsonPropertyName("context")]
        public IReadOnlyDictionary<string, object?> Context { get; init; } = new Dictionary<string, object?>();
    }

    private sealed class SetValueRequest
    {
        [JsonPropertyName("schemaId")]
        public string SchemaId { get; init; } = string.Empty;

        [JsonPropertyName("environmentId")]
        public string EnvironmentId { get; init; } = string.Empty;

        [JsonPropertyName("key")]
        public string Key { get; init; } = string.Empty;

        [JsonPropertyName("value")]
        public object? Value { get; init; }

        [JsonPropertyName("tier")]
        public string Tier { get; init; } = string.Empty;
    }
}

/// <summary>Thrown when the config API returns a non-success response.</summary>
public sealed class SmooConfigApiException : Exception
{
    /// <summary>HTTP status code returned by the server.</summary>
    public int StatusCode { get; }

    public SmooConfigApiException(string message, int statusCode) : base(message)
    {
        StatusCode = statusCode;
    }
}
