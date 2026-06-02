using System;
using System.Collections.Generic;
using System.Text;

namespace SmooAI.Config.Eso;

// ESO (ExternalSecrets Operator) manifest generator — C# parity port of the
// TypeScript src/eso-manifests (SMOODEV-1526, epic SMOODEV-1522).
//
// Emits the two ESO resources that let a Kubernetes workload pull its secrets
// from the @smooai/config HTTP API (api.smoo.ai) instead of having them baked
// at deploy time:
//   1. BuildClusterSecretStore — a ClusterSecretStore whose webhook provider
//      points at the real config-values endpoint (org + env baked into the URL,
//      bearer from the bootstrap Secret the eso-refresher keeps fresh).
//   2. BuildExternalSecret — a per-workload ExternalSecret mapping secret-tier
//      config keys to env-var names (UPPER_SNAKE_CASE by default, overridable).
//
// Returns plain Dictionary structures (any YAML/JSON serializer accepts them).
// No cluster or network access.

/// <summary>Reference to the k8s Secret + key holding the ESO bearer token.</summary>
public sealed class BootstrapSecretRef
{
    public string Name { get; init; } = EsoManifests.DefaultBootstrapSecretName;
    public string Namespace { get; init; } = EsoManifests.DefaultBootstrapSecretNamespace;
    public string Key { get; init; } = EsoManifests.DefaultBootstrapSecretKey;
}

/// <summary>Options for <see cref="EsoManifests.BuildClusterSecretStore"/>.</summary>
public sealed class ClusterSecretStoreOptions
{
    /// <summary>ClusterSecretStore name; defaults to <c>smooai-config</c>.</summary>
    public string? Name { get; init; }

    /// <summary>Config API base URL, e.g. <c>https://api.smoo.ai</c> (required).</summary>
    public required string ApiUrl { get; init; }

    /// <summary>Org id whose config this store reads (required).</summary>
    public required string OrgId { get; init; }

    /// <summary>Environment baked into the query string (required).</summary>
    public required string Environment { get; init; }

    public BootstrapSecretRef? BootstrapSecret { get; init; }
}

/// <summary>A config key → the env-var name the workload reads. EnvVar defaults
/// to UPPER_SNAKE_CASE(ConfigKey).</summary>
public sealed class SecretMapping
{
    public required string ConfigKey { get; init; }
    public string? EnvVar { get; init; }

    public SecretMapping() { }

    [System.Diagnostics.CodeAnalysis.SetsRequiredMembers]
    public SecretMapping(string configKey, string? envVar = null)
    {
        ConfigKey = configKey;
        EnvVar = envVar;
    }
}

/// <summary>Options for <see cref="EsoManifests.BuildExternalSecret"/>.</summary>
public sealed class ExternalSecretOptions
{
    public required string Name { get; init; }
    public required string Namespace { get; init; }
    public required IReadOnlyList<SecretMapping> Secrets { get; init; }
    public string? TargetSecretName { get; init; }
    public string? ClusterSecretStoreName { get; init; }
    public string? RefreshInterval { get; init; }
    public IReadOnlyDictionary<string, string>? Labels { get; init; }
}

public static class EsoManifests
{
    public const string DefaultClusterSecretStoreName = "smooai-config";
    public const string DefaultBootstrapSecretName = "smooai-config-bootstrap";
    public const string DefaultBootstrapSecretNamespace = "external-secrets";
    public const string DefaultBootstrapSecretKey = "bearer-token";
    public const string DefaultRefreshInterval = "1h";
    public const string ApiVersion = "external-secrets.io/v1beta1";

    /// <summary>
    /// Build a ClusterSecretStore backed by the @smooai/config webhook provider.
    /// org + environment are baked into the URL because ESO's webhook only
    /// templates <c>{{ .remoteRef.key }}</c> per-secret — so a store is scoped
    /// to one (org, env) pair.
    /// </summary>
    public static Dictionary<string, object?> BuildClusterSecretStore(ClusterSecretStoreOptions opts)
    {
        if (string.IsNullOrEmpty(opts.ApiUrl))
            throw new ArgumentException("BuildClusterSecretStore: ApiUrl is required");
        if (string.IsNullOrEmpty(opts.OrgId))
            throw new ArgumentException("BuildClusterSecretStore: OrgId is required");
        if (string.IsNullOrEmpty(opts.Environment))
            throw new ArgumentException("BuildClusterSecretStore: Environment is required");

        var name = string.IsNullOrEmpty(opts.Name) ? DefaultClusterSecretStoreName : opts.Name!;
        var apiUrl = opts.ApiUrl.TrimEnd('/');
        var r = opts.BootstrapSecret ?? new BootstrapSecretRef();
        var url = $"{apiUrl}/organizations/{opts.OrgId}/config/values/{{{{ .remoteRef.key }}}}?environment={EncodeQueryComponent(opts.Environment)}";

        return new Dictionary<string, object?>
        {
            ["apiVersion"] = ApiVersion,
            ["kind"] = "ClusterSecretStore",
            ["metadata"] = new Dictionary<string, object?> { ["name"] = name },
            ["spec"] = new Dictionary<string, object?>
            {
                ["provider"] = new Dictionary<string, object?>
                {
                    ["webhook"] = new Dictionary<string, object?>
                    {
                        ["url"] = url,
                        ["headers"] = new Dictionary<string, object?>
                        {
                            ["Content-Type"] = "application/json",
                            ["Authorization"] = "Bearer {{ .auth.token }}",
                        },
                        ["result"] = new Dictionary<string, object?> { ["jsonPath"] = "$.value" },
                        ["secrets"] = new List<object?>
                        {
                            new Dictionary<string, object?>
                            {
                                ["name"] = "auth",
                                ["secretRef"] = new Dictionary<string, object?>
                                {
                                    ["name"] = r.Name,
                                    ["namespace"] = r.Namespace,
                                    ["key"] = r.Key,
                                },
                            },
                        },
                    },
                },
            },
        };
    }

    /// <summary>Normalize a mapping, defaulting EnvVar to the UPPER_SNAKE_CASE of ConfigKey.</summary>
    public static (string ConfigKey, string EnvVar) ResolveSecretMapping(SecretMapping m)
    {
        if (string.IsNullOrEmpty(m.ConfigKey))
            throw new ArgumentException("ResolveSecretMapping: ConfigKey is required");
        var envVar = string.IsNullOrEmpty(m.EnvVar) ? CamelToUpperSnake(m.ConfigKey) : m.EnvVar!;
        return (m.ConfigKey, envVar);
    }

    /// <summary>
    /// Build a per-workload ExternalSecret. Each entry becomes a data mapping of
    /// secretKey (the env-var name in the synced Secret) ← remoteRef.key (the
    /// @smooai/config key).
    /// </summary>
    public static Dictionary<string, object?> BuildExternalSecret(ExternalSecretOptions opts)
    {
        if (string.IsNullOrEmpty(opts.Name))
            throw new ArgumentException("BuildExternalSecret: Name is required");
        if (string.IsNullOrEmpty(opts.Namespace))
            throw new ArgumentException("BuildExternalSecret: Namespace is required");
        if (opts.Secrets == null || opts.Secrets.Count == 0)
            throw new ArgumentException("BuildExternalSecret: at least one secret mapping is required");

        var data = new List<object?>(opts.Secrets.Count);
        var seen = new HashSet<string>();
        foreach (var entry in opts.Secrets)
        {
            var (configKey, envVar) = ResolveSecretMapping(entry);
            if (!seen.Add(envVar))
                throw new ArgumentException($"BuildExternalSecret: duplicate env-var name: {envVar}");
            data.Add(new Dictionary<string, object?>
            {
                ["secretKey"] = envVar,
                ["remoteRef"] = new Dictionary<string, object?> { ["key"] = configKey },
            });
        }

        var metadata = new Dictionary<string, object?>
        {
            ["name"] = opts.Name,
            ["namespace"] = opts.Namespace,
        };
        if (opts.Labels is { Count: > 0 })
            metadata["labels"] = new Dictionary<string, string>(opts.Labels);

        return new Dictionary<string, object?>
        {
            ["apiVersion"] = ApiVersion,
            ["kind"] = "ExternalSecret",
            ["metadata"] = metadata,
            ["spec"] = new Dictionary<string, object?>
            {
                ["refreshInterval"] = string.IsNullOrEmpty(opts.RefreshInterval) ? DefaultRefreshInterval : opts.RefreshInterval!,
                ["secretStoreRef"] = new Dictionary<string, object?>
                {
                    ["name"] = string.IsNullOrEmpty(opts.ClusterSecretStoreName) ? DefaultClusterSecretStoreName : opts.ClusterSecretStoreName!,
                    ["kind"] = "ClusterSecretStore",
                },
                ["target"] = new Dictionary<string, object?>
                {
                    ["name"] = string.IsNullOrEmpty(opts.TargetSecretName) ? opts.Name : opts.TargetSecretName!,
                    ["creationPolicy"] = "Owner",
                },
                ["data"] = data,
            },
        };
    }

    // camelCase → UPPER_SNAKE_CASE, matching the env-tier mapping in
    // Typed/EnvFileFallback.EnvVarNameFor (minus the prefix) so generated env
    // var names match what the C# SDK reads from the env tier.
    internal static string CamelToUpperSnake(string key)
    {
        var sb = new StringBuilder(key.Length + 8);
        for (int i = 0; i < key.Length; i++)
        {
            var c = key[i];
            if (char.IsUpper(c) && i > 0) sb.Append('_');
            sb.Append(char.ToUpperInvariant(c));
        }
        return sb.ToString();
    }

    // Percent-encode a query-string component (mirrors JS encodeURIComponent).
    private static string EncodeQueryComponent(string s)
    {
        var sb = new StringBuilder(s.Length);
        foreach (var b in Encoding.UTF8.GetBytes(s))
        {
            var c = (char)b;
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                || c == '-' || c == '_' || c == '.' || c == '~')
                sb.Append(c);
            else if (c == ' ')
                sb.Append("%20");
            else
                sb.Append('%').Append(b.ToString("X2"));
        }
        return sb.ToString();
    }
}
