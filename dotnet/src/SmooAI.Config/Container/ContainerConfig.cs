using System.Text;
using System.Text.Json;
using SmooAI.Config.OAuth;

namespace SmooAI.Config.Container;

/// <summary>
/// <c>SmooAI.Config</c> container / runtime mode (SMOODEV-1489 / SMOODEV-1491).
/// The .NET implementation of the five-language parity contract; mirrors the
/// TypeScript reference (SMOODEV-1490) exactly — identical env contract and
/// error semantics. Idioms differ (async <see cref="Task"/>, exceptions,
/// PascalCase); behavior does not.
/// </summary>
/// <remarks>
/// <para>
/// <c>SmooAI.Config</c> resolves values through four tiers: blob → env → http →
/// file. The blob tier (an encrypted bundle baked into a Lambda layer / image
/// at deploy time, decrypted with a separately-delivered key) is the blessed
/// path for <b>Lambda</b>. It is the <i>wrong</i> default for long-lived
/// <b>containers</b> (EKS/ECS): when the per-build blob key isn't delivered to
/// the pod, resolution silently falls through to the (absent) file tier and
/// returns <c>null</c> for a required secret (the SMOODEV-1478 CrashLoop).
/// </para>
/// <para>
/// Container mode makes the <b>HTTP tier the blessed, first-class path</b> for
/// containers, authenticated with an OAuth2 <c>client_credentials</c> (M2M)
/// token, and <b>fail-loud</b>: a missing required value is an immediate, typed
/// <see cref="ConfigKeyUnresolvedException"/>, never a silent <c>null</c>.
/// </para>
/// <para>
/// See <c>docs/Container-Runtime-Mode.md</c> for the env contract and the
/// Kubernetes / ExternalSecret recipe.
/// </para>
/// </remarks>
public static class ContainerConfig
{
    /// <summary>Default config-value cache TTL in ms (spec §5). Same 30s default in every SDK.</summary>
    public const int DefaultCacheTtlMs = 30_000;

    /// <summary>Default token proactive-refresh window in seconds (spec §5). Matches <see cref="TokenProvider"/>.</summary>
    public const int DefaultTokenRefreshBufferSeconds = 60;

    private const string DefaultAuthUrl = "https://auth.smoo.ai";

    /// <summary>
    /// Explicit container-mode bootstrap (spec §4). Validates the §1 env,
    /// constructs the M2M token provider + HTTP config client, and performs an
    /// <b>initial token mint + fetch-all-values</b> so auth/network failures
    /// surface at startup (not on first read). Returns a
    /// <see cref="ContainerConfigHandle"/> whose accessors are fail-loud (spec §3).
    /// </summary>
    /// <param name="options">Init options; every field mirrors a §1 env var.</param>
    /// <param name="cancellationToken">Cancellation token for the initial fetch.</param>
    /// <exception cref="ConfigBootstrapException">When container-required env is missing/blank.</exception>
    /// <exception cref="Exception">On auth/network failure during the initial token mint or fetch.</exception>
    public static async Task<ContainerConfigHandle> InitContainerConfigAsync(
        InitContainerConfigOptions options,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (options.Schema is null)
        {
            throw new ConfigBootstrapException(new[] { "Schema" });
        }

        var getEnv = options.GetEnv ?? Environment.GetEnvironmentVariable;
        var env = ResolveAndValidateEnv(options, getEnv);

        var cacheTtl = TimeSpan.FromMilliseconds(options.CacheTtlMs <= 0 ? DefaultCacheTtlMs : options.CacheTtlMs);
        var refreshBuffer = TimeSpan.FromSeconds(
            options.TokenRefreshBufferSeconds <= 0 ? DefaultTokenRefreshBufferSeconds : options.TokenRefreshBufferSeconds);

        // Build the ConfigClient. When the caller injects one (test/embedding
        // seam) it already carries its own TokenProvider, so we don't build a
        // second one (env creds may be empty in that path).
        SmooConfigClient client;
        if (options.ConfigClient is not null)
        {
            client = options.ConfigClient;
        }
        else
        {
            var clientOptions = new SmooConfigClientOptions
            {
                BaseUrl = env.ApiUrl,
                AuthUrl = env.AuthUrl,
                ClientId = env.ClientId,
                ClientSecret = env.ClientSecret,
                OrgId = env.OrgId,
                DefaultEnvironment = env.Environment,
                TokenRefreshWindow = refreshBuffer,
            };
            client = options.TokenProvider is not null
                ? SmooConfigClient.CreateWithTokenProvider(clientOptions, options.TokenProvider)
                : new SmooConfigClient(clientOptions);
        }

        var handle = new ContainerConfigHandle(client, options.Schema, env.Environment, cacheTtl, options.OptionalKeys, getEnv);

        // Initial fetch — fail loud at startup, not first read. The OAuth token
        // mint happens inside GetAllValuesAsync (the client's TokenProvider
        // exchanges on the first authed request), so an auth failure surfaces
        // here too. A pod that can't reach the config server should CrashLoop
        // visibly, not start degraded.
        await handle.PrimeAsync(cancellationToken).ConfigureAwait(false);

        return handle;
    }

    /// <summary>
    /// Standalone health check (spec §4) for a handle. Exposed both as
    /// <see cref="ContainerConfigHandle.Health"/> and as this static form for
    /// call sites that prefer the functional shape. Never throws.
    /// </summary>
    public static ConfigHealth Health(ContainerConfigHandle handle)
    {
        if (handle is null) return ConfigHealth.Unhealthy("handle is null");
        try
        {
            return handle.Health();
        }
        catch (Exception ex)
        {
            return ConfigHealth.Unhealthy(ex.Message);
        }
    }

    /// <summary>
    /// Mode the SDK should run in, per spec §2. <c>"container"</c> means
    /// HTTP-primary fail-loud; <c>"default"</c> means the existing
    /// blob → env → http → file chain.
    /// </summary>
    /// <remarks>
    /// Resolution order:
    /// <list type="number">
    ///   <item><c>SMOOAI_CONFIG_MODE=container</c> → container mode (explicit).</item>
    ///   <item>else if a blob/file source is present → default (Lambda/local), unchanged.</item>
    ///   <item>else if CLIENT_ID + CLIENT_SECRET + API_URL all set → container (auto).</item>
    ///   <item>else → default.</item>
    /// </list>
    /// </remarks>
    public static string SelectMode(SelectModeInputs? inputs = null)
    {
        inputs ??= new SelectModeInputs();
        var getEnv = inputs.GetEnv ?? Environment.GetEnvironmentVariable;

        var mode = NonBlank(inputs.Mode) ?? NonBlank(getEnv("SMOOAI_CONFIG_MODE"));
        if (string.Equals(mode, "container", StringComparison.OrdinalIgnoreCase)) return "container";

        var blobPresent = inputs.BlobPresent
            ?? (!string.IsNullOrEmpty(getEnv("SMOO_CONFIG_KEY")) && !string.IsNullOrEmpty(getEnv("SMOO_CONFIG_KEY_FILE")));
        var filePresent = inputs.FilePresent ?? false;
        if (blobPresent || filePresent) return "default";

        var clientId = NonBlank(inputs.ClientId) ?? NonBlank(getEnv("SMOOAI_CONFIG_CLIENT_ID"));
        var clientSecret = NonBlank(inputs.ClientSecret)
            ?? NonBlank(getEnv("SMOOAI_CONFIG_CLIENT_SECRET"))
            ?? NonBlank(getEnv("SMOOAI_CONFIG_API_KEY"));
        var apiUrl = NonBlank(inputs.ApiUrl) ?? NonBlank(getEnv("SMOOAI_CONFIG_API_URL"));

        if (clientId is not null && clientSecret is not null && apiUrl is not null)
        {
            return "container";
        }
        return "default";
    }

    /// <summary>camelCase → UPPER_SNAKE_CASE for env-var reads (matches the server tier).</summary>
    internal static string EnvVarNameFor(string key)
    {
        var sb = new StringBuilder(key.Length + 8);
        foreach (var ch in key)
        {
            if (char.IsUpper(ch))
            {
                sb.Append('_');
                sb.Append(ch);
            }
            else
            {
                sb.Append(char.ToUpperInvariant(ch));
            }
        }
        return sb.ToString();
    }

    /// <summary>Blank-aware presence check (a set-but-whitespace value counts as missing).</summary>
    internal static string? NonBlank(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value;

    private static ResolvedContainerEnv ResolveAndValidateEnv(InitContainerConfigOptions options, Func<string, string?> getEnv)
    {
        var apiUrl = NonBlank(options.ApiUrl) ?? NonBlank(getEnv("SMOOAI_CONFIG_API_URL"));
        var authUrl = NonBlank(options.AuthUrl)
            ?? NonBlank(getEnv("SMOOAI_CONFIG_AUTH_URL"))
            ?? NonBlank(getEnv("SMOOAI_AUTH_URL"))
            ?? DefaultAuthUrl;
        var clientId = NonBlank(options.ClientId) ?? NonBlank(getEnv("SMOOAI_CONFIG_CLIENT_ID"));
        var clientSecret = NonBlank(options.ClientSecret)
            ?? NonBlank(getEnv("SMOOAI_CONFIG_CLIENT_SECRET"))
            ?? NonBlank(getEnv("SMOOAI_CONFIG_API_KEY"));
        var orgId = NonBlank(options.OrgId) ?? NonBlank(getEnv("SMOOAI_CONFIG_ORG_ID"));
        var environment = NonBlank(options.Environment) ?? NonBlank(getEnv("SMOOAI_CONFIG_ENV"));

        // When a ConfigClient is injected it already carries apiUrl/auth/
        // clientId/secret/orgId — only the environment is still container-required.
        var clientInjected = options.ConfigClient is not null;

        var missing = new List<string>();
        if (!clientInjected)
        {
            if (apiUrl is null) missing.Add("SMOOAI_CONFIG_API_URL");
            if (clientId is null) missing.Add("SMOOAI_CONFIG_CLIENT_ID");
            if (clientSecret is null) missing.Add("SMOOAI_CONFIG_CLIENT_SECRET");
            if (orgId is null) missing.Add("SMOOAI_CONFIG_ORG_ID");
        }
        if (environment is null) missing.Add("SMOOAI_CONFIG_ENV");

        if (missing.Count > 0)
        {
            throw new ConfigBootstrapException(missing);
        }

        return new ResolvedContainerEnv(
            apiUrl ?? string.Empty,
            authUrl,
            clientId ?? string.Empty,
            clientSecret ?? string.Empty,
            orgId ?? string.Empty,
            environment!);
    }

    private sealed record ResolvedContainerEnv(
        string ApiUrl,
        string AuthUrl,
        string ClientId,
        string ClientSecret,
        string OrgId,
        string Environment);
}

/// <summary>Inputs for <see cref="ContainerConfig.SelectMode"/>. Defaults read from the process env.</summary>
public sealed class SelectModeInputs
{
    /// <summary><c>SMOOAI_CONFIG_MODE</c>.</summary>
    public string? Mode { get; init; }

    /// <summary><c>SMOOAI_CONFIG_CLIENT_ID</c>.</summary>
    public string? ClientId { get; init; }

    /// <summary><c>SMOOAI_CONFIG_CLIENT_SECRET</c> (or legacy <c>SMOOAI_CONFIG_API_KEY</c>).</summary>
    public string? ClientSecret { get; init; }

    /// <summary><c>SMOOAI_CONFIG_API_URL</c>.</summary>
    public string? ApiUrl { get; init; }

    /// <summary>Whether a baked blob source is present (<c>SMOO_CONFIG_KEY</c> + <c>SMOO_CONFIG_KEY_FILE</c>).</summary>
    public bool? BlobPresent { get; init; }

    /// <summary>Whether a local <c>.smooai-config/</c> file source is present.</summary>
    public bool? FilePresent { get; init; }

    /// <summary>Test-only seam — override env-var lookup.</summary>
    internal Func<string, string?>? GetEnv { get; init; }
}
