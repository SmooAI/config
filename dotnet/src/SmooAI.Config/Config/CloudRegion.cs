namespace SmooAI.Config.Config;

/// <summary>The detected cloud provider and region.</summary>
/// <param name="Provider">One of <c>aws</c>, <c>azure</c>, <c>gcp</c>, a custom override, or <c>unknown</c>.</param>
/// <param name="Region">The provider's region identifier, or <c>unknown</c>.</param>
public sealed record CloudRegionResult(string Provider, string Region);

/// <summary>
/// Detects the cloud provider and region from environment variables.
/// </summary>
/// <remarks>
/// Port of <c>src/config/getCloudRegion.ts</c> and <c>go/config/cloud_region.go</c>.
/// </remarks>
public static class CloudRegion
{
    /// <summary>Value reported when nothing identifies the environment.</summary>
    public const string Unknown = "unknown";

    /// <summary>Detect from the process environment.</summary>
    /// <returns>The detected provider and region.</returns>
    public static CloudRegionResult Get() => GetFromEnv(ReadProcessEnvironment());

    /// <summary>
    /// Detect from an explicit environment map.
    /// </summary>
    /// <param name="env">The environment to inspect.</param>
    /// <returns>The detected provider and region.</returns>
    /// <remarks>
    /// Detection order, first hit wins:
    /// <list type="number">
    /// <item><description><c>SMOOAI_CONFIG_CLOUD_REGION</c> / <c>SMOOAI_CONFIG_CLOUD_PROVIDER</c> (custom override)</description></item>
    /// <item><description><c>AWS_REGION</c> / <c>AWS_DEFAULT_REGION</c></description></item>
    /// <item><description><c>AZURE_REGION</c> / <c>AZURE_LOCATION</c></description></item>
    /// <item><description><c>GOOGLE_CLOUD_REGION</c> / <c>CLOUDSDK_COMPUTE_REGION</c></description></item>
    /// <item><description>otherwise <c>unknown</c>/<c>unknown</c></description></item>
    /// </list>
    /// </remarks>
    public static CloudRegionResult GetFromEnv(IReadOnlyDictionary<string, string?> env)
    {
        ArgumentNullException.ThrowIfNull(env);

        // 1. Custom override — either half is enough to select this branch, so
        //    a provider can be named without pinning a region and vice versa.
        var overrideRegion = Read(env, "SMOOAI_CONFIG_CLOUD_REGION");
        var overrideProvider = Read(env, "SMOOAI_CONFIG_CLOUD_PROVIDER");
        if (overrideRegion is not null || overrideProvider is not null)
        {
            return new CloudRegionResult(overrideProvider ?? Unknown, overrideRegion ?? Unknown);
        }

        // 2. AWS
        if (Coalesce(env, "AWS_REGION", "AWS_DEFAULT_REGION") is { } aws) return new CloudRegionResult("aws", aws);

        // 3. Azure
        if (Coalesce(env, "AZURE_REGION", "AZURE_LOCATION") is { } azure) return new CloudRegionResult("azure", azure);

        // 4. GCP
        if (Coalesce(env, "GOOGLE_CLOUD_REGION", "CLOUDSDK_COMPUTE_REGION") is { } gcp) return new CloudRegionResult("gcp", gcp);

        return new CloudRegionResult(Unknown, Unknown);
    }

    private static string? Read(IReadOnlyDictionary<string, string?> env, string name)
        => env.TryGetValue(name, out var value) && !string.IsNullOrEmpty(value) ? value : null;

    private static string? Coalesce(IReadOnlyDictionary<string, string?> env, params string[] names)
    {
        foreach (var name in names)
        {
            if (Read(env, name) is { } value) return value;
        }
        return null;
    }

    internal static Dictionary<string, string?> ReadProcessEnvironment()
    {
        var result = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            if (entry.Key is string key) result[key] = entry.Value as string;
        }
        return result;
    }
}
