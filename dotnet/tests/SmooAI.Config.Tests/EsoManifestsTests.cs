using System.Collections.Generic;
using SmooAI.Config.Eso;

namespace SmooAI.Config.Tests;

// SMOODEV-1526 — ESO manifest generator parity tests (C#).
public class EsoManifestsTests
{
    private static Dictionary<string, object?> Dict(object? o) => (Dictionary<string, object?>)o!;
    private static List<object?> Arr(object? o) => (List<object?>)o!;

    private static object? Webhook(Dictionary<string, object?> store) =>
        Dict(Dict(Dict(store["spec"])["provider"])["webhook"]);

    [Fact]
    public void ClusterSecretStore_BakesOrgAndEnv()
    {
        var store = EsoManifests.BuildClusterSecretStore(new ClusterSecretStoreOptions
        {
            ApiUrl = "https://api.smoo.ai",
            OrgId = "org-123",
            Environment = "production",
        });
        var webhook = Dict(Webhook(store));
        var url = (string)webhook["url"]!;
        Assert.Equal("https://api.smoo.ai/organizations/org-123/config/values/{{ .remoteRef.key }}?environment=production", url);
        Assert.DoesNotContain("config.smoo.ai", url);
        Assert.Equal("$.value", (string)Dict(webhook["result"])["jsonPath"]!);
    }

    [Fact]
    public void ClusterSecretStore_DefaultsAndEncoding()
    {
        var store = EsoManifests.BuildClusterSecretStore(new ClusterSecretStoreOptions
        {
            ApiUrl = "https://api.smoo.ai///",
            OrgId = "o",
            Environment = "pre prod",
        });
        var webhook = Dict(Webhook(store));
        var url = (string)webhook["url"]!;
        Assert.StartsWith("https://api.smoo.ai/organizations", url);
        Assert.Contains("environment=pre%20prod", url);
        var secretRef = Dict(Dict(Arr(webhook["secrets"])[0])["secretRef"]);
        Assert.Equal("smooai-config-bootstrap", secretRef["name"]);
        Assert.Equal("external-secrets", secretRef["namespace"]);
        Assert.Equal("bearer-token", secretRef["key"]);
    }

    [Fact]
    public void ClusterSecretStore_RequiredFields()
    {
        Assert.Throws<System.ArgumentException>(() =>
            EsoManifests.BuildClusterSecretStore(new ClusterSecretStoreOptions { ApiUrl = "", OrgId = "o", Environment = "e" }));
        Assert.Throws<System.ArgumentException>(() =>
            EsoManifests.BuildClusterSecretStore(new ClusterSecretStoreOptions { ApiUrl = "u", OrgId = "", Environment = "e" }));
        Assert.Throws<System.ArgumentException>(() =>
            EsoManifests.BuildClusterSecretStore(new ClusterSecretStoreOptions { ApiUrl = "u", OrgId = "o", Environment = "" }));
    }

    [Fact]
    public void ResolveSecretMapping_DefaultsAndOverride()
    {
        Assert.Equal("MIMO_API_KEY", EsoManifests.ResolveSecretMapping(new SecretMapping("mimoApiKey")).EnvVar);
        Assert.Equal("DASHSCOPE_API_KEY", EsoManifests.ResolveSecretMapping(new SecretMapping("alibabaModelStudioApiKey", "DASHSCOPE_API_KEY")).EnvVar);
    }

    [Fact]
    public void ExternalSecret_MapsKeys()
    {
        var es = EsoManifests.BuildExternalSecret(new ExternalSecretOptions
        {
            Name = "litellm-config",
            Namespace = "smooai-litellm",
            Secrets = new List<SecretMapping>
            {
                new("mimoApiKey"),
                new("alibabaModelStudioApiKey", "DASHSCOPE_API_KEY"),
            },
        });
        var spec = Dict(es["spec"]);
        var data = Arr(spec["data"]);
        var first = Dict(data[0]);
        Assert.Equal("MIMO_API_KEY", first["secretKey"]);
        Assert.Equal("mimoApiKey", Dict(first["remoteRef"])["key"]);
        Assert.Equal("DASHSCOPE_API_KEY", Dict(data[1])["secretKey"]);
        Assert.Equal("litellm-config", Dict(spec["target"])["name"]);
        Assert.Equal("smooai-config", Dict(spec["secretStoreRef"])["name"]);
    }

    [Fact]
    public void ExternalSecret_DuplicateEnvVar()
    {
        var ex = Assert.Throws<System.ArgumentException>(() =>
            EsoManifests.BuildExternalSecret(new ExternalSecretOptions
            {
                Name = "x",
                Namespace = "ns",
                Secrets = new List<SecretMapping>
                {
                    new("mimoApiKey"),
                    new("somethingElse", "MIMO_API_KEY"),
                },
            }));
        Assert.Contains("duplicate env-var", ex.Message);
    }

    [Fact]
    public void ExternalSecret_RequiredFields()
    {
        Assert.Throws<System.ArgumentException>(() =>
            EsoManifests.BuildExternalSecret(new ExternalSecretOptions { Name = "", Namespace = "ns", Secrets = new List<SecretMapping> { new("k") } }));
        Assert.Throws<System.ArgumentException>(() =>
            EsoManifests.BuildExternalSecret(new ExternalSecretOptions { Name = "n", Namespace = "", Secrets = new List<SecretMapping> { new("k") } }));
        Assert.Throws<System.ArgumentException>(() =>
            EsoManifests.BuildExternalSecret(new ExternalSecretOptions { Name = "n", Namespace = "ns", Secrets = new List<SecretMapping>() }));
    }
}
