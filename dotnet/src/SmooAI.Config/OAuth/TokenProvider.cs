using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace SmooAI.Config.OAuth;

/// <summary>
/// Exchanges OAuth2 client credentials for an access token against
/// <c>{authUrl}/token</c> and caches the result in memory. Refreshes the
/// token when it is within <see cref="RefreshWindow"/> of expiry.
/// </summary>
/// <remarks>
/// Server contract (SMOODEV-643, matches TS/Rust/Go clients):
/// <code>
/// POST {authUrl}/token
/// Content-Type: application/x-www-form-urlencoded
/// grant_type=client_credentials
/// provider=client_credentials
/// client_id=&lt;uuid&gt;
/// client_secret=sk_...
/// </code>
/// </remarks>
public sealed class TokenProvider
{
    private readonly HttpClient _httpClient;
    private readonly string _authUrl;
    private readonly string _clientId;
    private readonly string _clientSecret;
    private readonly SemaphoreSlim _lock = new(1, 1);

    private string? _accessToken;
    private DateTimeOffset _expiresAt;

    /// <summary>How long before expiry to proactively refresh the token.</summary>
    public TimeSpan RefreshWindow { get; }

    /// <summary>The time provider used for expiry checks (swap in tests).</summary>
    internal Func<DateTimeOffset> UtcNow { get; set; } = () => DateTimeOffset.UtcNow;

    public TokenProvider(HttpClient httpClient, string authUrl, string clientId, string clientSecret, TimeSpan? refreshWindow = null)
    {
        _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
        _authUrl = (authUrl ?? throw new ArgumentNullException(nameof(authUrl))).TrimEnd('/');
        _clientId = clientId ?? throw new ArgumentNullException(nameof(clientId));
        _clientSecret = clientSecret ?? throw new ArgumentNullException(nameof(clientSecret));
        RefreshWindow = refreshWindow ?? TimeSpan.FromSeconds(60);
    }

    /// <summary>Returns a valid access token, refreshing from the server if needed.</summary>
    public async Task<string> GetAccessTokenAsync(CancellationToken cancellationToken = default)
    {
        if (!ShouldRefresh()) return _accessToken!;

        await _lock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (!ShouldRefresh()) return _accessToken!;
            await RefreshAsync(cancellationToken).ConfigureAwait(false);
            return _accessToken!;
        }
        finally
        {
            _lock.Release();
        }
    }

    /// <summary>Invalidates the cached token so the next call re-exchanges.</summary>
    public void Invalidate()
    {
        _accessToken = null;
        _expiresAt = DateTimeOffset.MinValue;
    }

    private bool ShouldRefresh()
    {
        if (string.IsNullOrEmpty(_accessToken)) return true;
        return UtcNow() >= _expiresAt - RefreshWindow;
    }

    private async Task RefreshAsync(CancellationToken cancellationToken)
    {
        var form = new FormUrlEncodedContent(new[]
        {
            new KeyValuePair<string, string>("grant_type", "client_credentials"),
            new KeyValuePair<string, string>("provider", "client_credentials"),
            new KeyValuePair<string, string>("client_id", _clientId),
            new KeyValuePair<string, string>("client_secret", _clientSecret),
        });

        var tokenEndpoint = $"{_authUrl}/token";
        using var request = new HttpRequestMessage(HttpMethod.Post, tokenEndpoint) { Content = form };

        HttpResponseMessage response;
        try
        {
            response = await _httpClient.SendAsync(request, cancellationToken).ConfigureAwait(false);
        }
        catch (HttpRequestException ex)
        {
            throw new TokenExchangeException(
                $"Token exchange failed: could not reach {tokenEndpoint} ({ex.Message}). Check your network connection or --auth-url flag.",
                statusCode: null,
                ex);
        }

        try
        {
            if (!response.IsSuccessStatusCode)
            {
                var body = await SafeReadAsync(response, cancellationToken).ConfigureAwait(false);
                var status = (int)response.StatusCode;
                var hint = status is 401 or 403
                    ? " Check your client_id and client_secret belong to this organization."
                    : string.Empty;
                throw new TokenExchangeException(
                    $"Token exchange failed: HTTP {status} {response.ReasonPhrase}{(string.IsNullOrEmpty(body) ? string.Empty : $" — {body}")}.{hint}",
                    statusCode: status);
            }

            var parsed = await response.Content.ReadFromJsonAsync<TokenResponse>(cancellationToken: cancellationToken).ConfigureAwait(false);
            if (parsed is null || string.IsNullOrEmpty(parsed.AccessToken))
            {
                throw new TokenExchangeException("Token exchange returned malformed response — missing access_token.", statusCode: (int)response.StatusCode);
            }

            var expiresInSeconds = parsed.ExpiresIn is > 0 ? parsed.ExpiresIn.Value : 3600;
            _accessToken = parsed.AccessToken;
            _expiresAt = UtcNow().AddSeconds(expiresInSeconds);
        }
        finally
        {
            response.Dispose();
        }
    }

    private static async Task<string> SafeReadAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        try { return await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false); }
        catch { return string.Empty; }
    }

    private sealed class TokenResponse
    {
        [JsonPropertyName("access_token")]
        public string? AccessToken { get; init; }

        [JsonPropertyName("token_type")]
        public string? TokenType { get; init; }

        [JsonPropertyName("expires_in")]
        public int? ExpiresIn { get; init; }
    }
}

/// <summary>Thrown when the OAuth2 token exchange fails.</summary>
public sealed class TokenExchangeException : Exception
{
    /// <summary>HTTP status code returned by the auth server, if any.</summary>
    public int? StatusCode { get; }

    public TokenExchangeException(string message, int? statusCode, Exception? inner = null)
        : base(message, inner)
    {
        StatusCode = statusCode;
    }
}
