namespace SmooAI.Config.Container;

/// <summary>
/// Thrown by <see cref="ContainerConfig.InitContainerConfigAsync"/> when the
/// container-required environment (spec §1) is missing or blank. Carries the
/// exact list of offending env var names so the operator can fix the
/// deployment without guessing. No partial init: if any required var is
/// absent, bootstrap fails whole.
/// </summary>
/// <remarks>
/// Parity note: the TS/go/python/rust SDKs expose this with the same name and
/// the same carried field (<c>missing: string[]</c> ↔ <see cref="Missing"/>).
/// </remarks>
public sealed class ConfigBootstrapException : Exception
{
    /// <summary>
    /// Env var names (e.g. <c>SMOOAI_CONFIG_CLIENT_ID</c>) that are missing or
    /// blank. Never empty when this exception is thrown.
    /// </summary>
    public IReadOnlyList<string> Missing { get; }

    /// <summary>Create the exception from the list of missing env var names.</summary>
    public ConfigBootstrapException(IReadOnlyList<string> missing)
        : base(BuildMessage(missing))
    {
        Missing = missing ?? Array.Empty<string>();
    }

    private static string BuildMessage(IReadOnlyList<string>? missing)
    {
        var names = missing is null || missing.Count == 0 ? "(none)" : string.Join(", ", missing);
        var which = missing is { Count: 1 } ? "this variable" : "these variables";
        return $"[SmooAI.Config] container-mode bootstrap failed: missing required env {names}. " +
               $"Set {which} before calling InitContainerConfigAsync() " +
               "(see docs/Container-Runtime-Mode.md for the Kubernetes/ExternalSecret recipe).";
    }
}

/// <summary>
/// Thrown by a required-key read (<c>SecretConfig.GetAsync</c>/<c>GetSync</c>
/// and the public/flag analogs) in container mode when the value resolves to
/// absent across every active tier. This is the exact class that closes the
/// silent-<c>null</c> hole (SMOODEV-1478 / SMOODEV-1135).
/// </summary>
/// <remarks>
/// Optional keys (declared via <c>InitContainerConfigOptions.OptionalKeys</c>)
/// do NOT throw this — they return the language's absent value (<c>null</c> /
/// <c>default</c>).
/// <para>
/// Parity note: the TS/go/python/rust SDKs expose this with the same name and
/// the same carried fields (<c>key</c>, <c>env</c>, <c>triedTiers</c> ↔
/// <see cref="Key"/>, <see cref="Env"/>, <see cref="TriedTiers"/>).
/// </para>
/// </remarks>
public sealed class ConfigKeyUnresolvedException : Exception
{
    /// <summary>The camelCase config key that could not be resolved.</summary>
    public string Key { get; }

    /// <summary>The environment the read targeted (e.g. <c>production</c>).</summary>
    public string Env { get; }

    /// <summary>The tiers that were consulted, in order, before giving up (e.g. <c>["env", "http"]</c>).</summary>
    public IReadOnlyList<string> TriedTiers { get; }

    /// <summary>Create the exception with the key, environment, and tiers tried.</summary>
    public ConfigKeyUnresolvedException(string key, string env, IReadOnlyList<string> triedTiers)
        : base(BuildMessage(key, env, triedTiers))
    {
        Key = key;
        Env = env;
        TriedTiers = triedTiers ?? Array.Empty<string>();
    }

    private static string BuildMessage(string key, string env, IReadOnlyList<string>? triedTiers)
    {
        var tiers = triedTiers is null || triedTiers.Count == 0 ? "none" : string.Join(" → ", triedTiers);
        return $"[SmooAI.Config] required config key \"{key}\" did not resolve in environment \"{env}\" " +
               $"(container mode; tiers tried: {tiers}). " +
               $"Set a value for this key in the config server for \"{env}\", or mark it optional via " +
               $"InitContainerConfigOptions.OptionalKeys.";
    }
}
