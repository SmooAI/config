using SmooAI.Config.OAuth;

namespace SmooAI.Config.Container;

/// <summary>
/// Options for <see cref="ContainerConfig.InitContainerConfigAsync"/>. Every
/// field mirrors an env var in the spec §1 contract so tests and embedders can
/// construct a config handle without touching the process environment. When a
/// field is omitted (null), the corresponding env var is read.
/// </summary>
public sealed class InitContainerConfigOptions
{
    /// <summary>
    /// The schema for this service. Required so the handle can validate which
    /// keys exist and which tier each belongs to. Every declared key is treated
    /// as <b>required</b> in container mode by default — see
    /// <see cref="OptionalKeys"/>.
    /// </summary>
    public required ContainerConfigSchema Schema { get; init; }

    /// <summary>Config API base URL. Falls back to <c>SMOOAI_CONFIG_API_URL</c>.</summary>
    public string? ApiUrl { get; init; }

    /// <summary>
    /// OAuth issuer base URL. Falls back to <c>SMOOAI_CONFIG_AUTH_URL</c>, then
    /// legacy <c>SMOOAI_AUTH_URL</c>, then <c>https://auth.smoo.ai</c>.
    /// </summary>
    public string? AuthUrl { get; init; }

    /// <summary>M2M OAuth client id. Falls back to <c>SMOOAI_CONFIG_CLIENT_ID</c>.</summary>
    public string? ClientId { get; init; }

    /// <summary>
    /// M2M OAuth client secret. Falls back to <c>SMOOAI_CONFIG_CLIENT_SECRET</c>,
    /// then legacy <c>SMOOAI_CONFIG_API_KEY</c>.
    /// </summary>
    public string? ClientSecret { get; init; }

    /// <summary>Org id whose config to fetch. Falls back to <c>SMOOAI_CONFIG_ORG_ID</c>.</summary>
    public string? OrgId { get; init; }

    /// <summary>Environment name (e.g. <c>production</c>). Falls back to <c>SMOOAI_CONFIG_ENV</c>.</summary>
    public string? Environment { get; init; }

    /// <summary>
    /// Config value cache TTL in milliseconds. Default
    /// <see cref="ContainerConfig.DefaultCacheTtlMs"/> (30s). A background
    /// refresh failure serves the last-good value until this TTL hard-expires,
    /// at which point <see cref="ContainerConfigHandle.Health"/> reports
    /// <c>unhealthy</c> (spec §5).
    /// </summary>
    public int CacheTtlMs { get; init; } = ContainerConfig.DefaultCacheTtlMs;

    /// <summary>
    /// Seconds before token expiry to proactively refresh. Default
    /// <see cref="ContainerConfig.DefaultTokenRefreshBufferSeconds"/> (60s).
    /// Forwarded to the OAuth <see cref="TokenProvider"/>.
    /// </summary>
    public int TokenRefreshBufferSeconds { get; init; } = ContainerConfig.DefaultTokenRefreshBufferSeconds;

    /// <summary>
    /// Keys that are allowed to be absent. A read of any of these returns the
    /// absent value (<c>null</c> / <c>default</c>) instead of throwing
    /// <see cref="ConfigKeyUnresolvedException"/>. Everything else declared in
    /// <see cref="Schema"/> is required (container mode's default-required
    /// posture).
    /// </summary>
    public IReadOnlyList<string>? OptionalKeys { get; init; }

    /// <summary>
    /// Test / embedding seam — inject a pre-built <see cref="SmooConfigClient"/>.
    /// When supplied, <c>ApiUrl</c>/<c>AuthUrl</c>/<c>ClientId</c>/
    /// <c>ClientSecret</c>/<c>OrgId</c> env validation is skipped (the client
    /// already carries them) but <c>Environment</c> is still required.
    /// </summary>
    public SmooConfigClient? ConfigClient { get; init; }

    /// <summary>
    /// Test / embedding seam — inject a pre-built <see cref="TokenProvider"/>.
    /// Used only when <see cref="ConfigClient"/> is not supplied.
    /// </summary>
    public TokenProvider? TokenProvider { get; init; }

    /// <summary>
    /// Test-only seam — override the env-var lookup. Defaults to
    /// <see cref="System.Environment.GetEnvironmentVariable(string)"/>.
    /// </summary>
    internal Func<string, string?>? GetEnv { get; init; }
}

/// <summary>
/// Status returned by <see cref="ContainerConfigHandle.Health"/> and
/// <see cref="ContainerConfig.Health"/>. Never thrown — always inspected.
/// </summary>
public sealed class ConfigHealth
{
    /// <summary><c>"healthy"</c> or <c>"unhealthy"</c>.</summary>
    public string Status { get; }

    /// <summary>Human-readable reason when <see cref="Status"/> is <c>"unhealthy"</c>; otherwise null.</summary>
    public string? Reason { get; }

    private ConfigHealth(string status, string? reason)
    {
        Status = status;
        Reason = reason;
    }

    /// <summary>Whether the active config source is usable.</summary>
    public bool IsHealthy => Status == HealthyStatus;

    internal const string HealthyStatus = "healthy";
    internal const string UnhealthyStatus = "unhealthy";

    /// <summary>A healthy status.</summary>
    public static ConfigHealth Healthy() => new(HealthyStatus, null);

    /// <summary>An unhealthy status with the given reason.</summary>
    public static ConfigHealth Unhealthy(string reason) => new(UnhealthyStatus, reason);
}
