namespace SmooAI.Config.Container;

/// <summary>
/// One of the resolution tiers consulted during a container-mode value read.
/// Mirrors the TS <c>ConfigTier</c> union (<c>blob | env | http | file</c>).
/// In container mode only <see cref="Env"/> and <see cref="Http"/> are active;
/// the blob/file tiers are disabled (see the spec §2).
/// </summary>
public enum ResolutionTier
{
    /// <summary>The baked, AES-GCM-encrypted blob tier (disabled in container mode).</summary>
    Blob,

    /// <summary>An explicit process environment variable override (<c>UPPER_SNAKE_CASE(key)</c>).</summary>
    Env,

    /// <summary>The HTTP config API — the blessed container path.</summary>
    Http,

    /// <summary>The local <c>.smooai-config/&lt;env&gt;.json</c> file tier (disabled in container mode).</summary>
    File,
}

/// <summary>String-rendering for <see cref="ResolutionTier"/> matching the TS wire names.</summary>
public static class ResolutionTierExtensions
{
    /// <summary>Render a tier as the lowercase string used in error messages and parity tests.</summary>
    public static string ToWireString(this ResolutionTier tier) => tier switch
    {
        ResolutionTier.Blob => "blob",
        ResolutionTier.Env => "env",
        ResolutionTier.Http => "http",
        ResolutionTier.File => "file",
        _ => throw new System.ArgumentOutOfRangeException(nameof(tier), tier, null),
    };
}
