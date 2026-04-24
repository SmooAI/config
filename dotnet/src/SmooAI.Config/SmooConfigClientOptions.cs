namespace SmooAI.Config;

/// <summary>
/// Options passed to <see cref="SmooConfigClient"/>.
/// </summary>
public sealed class SmooConfigClientOptions
{
    /// <summary>OAuth2 client id (UUID). Required.</summary>
    public string ClientId { get; set; } = string.Empty;

    /// <summary>OAuth2 client secret (<c>sk_...</c>). Required.</summary>
    public string ClientSecret { get; set; } = string.Empty;

    /// <summary>Organization UUID to scope all requests to. Required.</summary>
    public string OrgId { get; set; } = string.Empty;

    /// <summary>Base URL of the Smoo AI config API. Defaults to <c>https://api.smoo.ai</c>.</summary>
    public string BaseUrl { get; set; } = "https://api.smoo.ai";

    /// <summary>
    /// OAuth2 auth base URL. When null, derived automatically from
    /// <see cref="BaseUrl"/> by replacing the <c>api.</c> subdomain with <c>auth.</c>
    /// (e.g. <c>api.smoo.ai → auth.smoo.ai</c>).
    /// </summary>
    public string? AuthUrl { get; set; }

    /// <summary>Default environment name to use when callers pass null. Defaults to <c>production</c>.</summary>
    public string DefaultEnvironment { get; set; } = "production";

    /// <summary>
    /// Refresh window — how long before token expiry to proactively refresh.
    /// Defaults to 60 seconds to match the TS/Rust/Go clients.
    /// </summary>
    public TimeSpan TokenRefreshWindow { get; set; } = TimeSpan.FromSeconds(60);

    /// <summary>
    /// Derive the auth URL from the base URL by swapping the <c>api.</c>
    /// subdomain for <c>auth.</c>. Exposed for unit tests.
    /// </summary>
    public static string DeriveAuthUrl(string baseUrl)
    {
        if (string.IsNullOrWhiteSpace(baseUrl)) throw new ArgumentException("BaseUrl cannot be empty.", nameof(baseUrl));

        if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var parsed))
        {
            throw new ArgumentException($"BaseUrl is not a valid absolute URL: {baseUrl}", nameof(baseUrl));
        }

        var host = parsed.Host;
        var authHost = host.StartsWith("api.", StringComparison.OrdinalIgnoreCase)
            ? "auth." + host["api.".Length..]
            : host;

        var builder = new UriBuilder(parsed) { Host = authHost, Path = string.Empty };
        // UriBuilder adds port -1 fine; trailing "/" is harmless but strip it.
        return builder.Uri.GetLeftPart(UriPartial.Authority);
    }

    internal void Validate()
    {
        if (string.IsNullOrWhiteSpace(ClientId)) throw new ArgumentException("ClientId is required.", nameof(ClientId));
        if (string.IsNullOrWhiteSpace(ClientSecret)) throw new ArgumentException("ClientSecret is required.", nameof(ClientSecret));
        if (string.IsNullOrWhiteSpace(OrgId)) throw new ArgumentException("OrgId is required.", nameof(OrgId));
        if (string.IsNullOrWhiteSpace(BaseUrl)) throw new ArgumentException("BaseUrl is required.", nameof(BaseUrl));
    }
}
