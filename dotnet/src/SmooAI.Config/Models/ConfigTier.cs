namespace SmooAI.Config.Models;

/// <summary>
/// Tier of a config value. Mirrors the TS/Rust/Go clients — the server
/// uses these strings verbatim on the <c>PUT /config/values</c> body.
/// </summary>
public enum ConfigTier
{
    /// <summary>Non-sensitive public configuration value.</summary>
    Public,

    /// <summary>Secret value (encrypted at rest, masked in logs).</summary>
    Secret,

    /// <summary>Feature flag value (boolean or structured rollout rule).</summary>
    FeatureFlag,
}

internal static class ConfigTierExtensions
{
    /// <summary>Render a tier as the lowercase wire string the server expects.</summary>
    public static string ToWireString(this ConfigTier tier) => tier switch
    {
        ConfigTier.Public => "public",
        ConfigTier.Secret => "secret",
        ConfigTier.FeatureFlag => "featureFlag",
        _ => throw new System.ArgumentOutOfRangeException(nameof(tier), tier, null),
    };
}
