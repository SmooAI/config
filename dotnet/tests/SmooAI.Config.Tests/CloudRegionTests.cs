using SmooAI.Config.Config;

namespace SmooAI.Config.Tests;

public class CloudRegionTests
{
    private static Dictionary<string, string?> Env(params (string Key, string? Value)[] entries)
        => entries.ToDictionary(entry => entry.Key, entry => entry.Value, StringComparer.Ordinal);

    [Fact]
    public void DetectsAws()
    {
        Assert.Equal(new CloudRegionResult("aws", "us-east-1"), CloudRegion.GetFromEnv(Env(("AWS_REGION", "us-east-1"))));
    }

    [Fact]
    public void FallsBackToAwsDefaultRegion()
    {
        Assert.Equal(new CloudRegionResult("aws", "eu-west-2"), CloudRegion.GetFromEnv(Env(("AWS_DEFAULT_REGION", "eu-west-2"))));
    }

    [Fact]
    public void DetectsAzure()
    {
        Assert.Equal(new CloudRegionResult("azure", "westus2"), CloudRegion.GetFromEnv(Env(("AZURE_REGION", "westus2"))));
        Assert.Equal(new CloudRegionResult("azure", "eastus"), CloudRegion.GetFromEnv(Env(("AZURE_LOCATION", "eastus"))));
    }

    [Fact]
    public void DetectsGcp()
    {
        Assert.Equal(new CloudRegionResult("gcp", "us-central1"), CloudRegion.GetFromEnv(Env(("GOOGLE_CLOUD_REGION", "us-central1"))));
        Assert.Equal(new CloudRegionResult("gcp", "europe-west1"), CloudRegion.GetFromEnv(Env(("CLOUDSDK_COMPUTE_REGION", "europe-west1"))));
    }

    [Fact]
    public void CustomOverrideBeatsEveryProvider()
    {
        var env = Env(
            ("SMOOAI_CONFIG_CLOUD_PROVIDER", "fly"),
            ("SMOOAI_CONFIG_CLOUD_REGION", "iad"),
            ("AWS_REGION", "us-east-1"));

        Assert.Equal(new CloudRegionResult("fly", "iad"), CloudRegion.GetFromEnv(env));
    }

    [Fact]
    public void HalfAnOverrideStillSelectsTheOverrideBranch()
    {
        // Either half selects the branch, so a provider named without a region
        // does NOT silently fall through to AWS detection.
        Assert.Equal(new CloudRegionResult("fly", "unknown"), CloudRegion.GetFromEnv(Env(("SMOOAI_CONFIG_CLOUD_PROVIDER", "fly"), ("AWS_REGION", "us-east-1"))));
        Assert.Equal(new CloudRegionResult("unknown", "iad"), CloudRegion.GetFromEnv(Env(("SMOOAI_CONFIG_CLOUD_REGION", "iad"), ("AWS_REGION", "us-east-1"))));
    }

    [Fact]
    public void ProviderPrecedenceIsAwsThenAzureThenGcp()
    {
        var env = Env(("AWS_REGION", "us-east-1"), ("AZURE_REGION", "westus2"), ("GOOGLE_CLOUD_REGION", "us-central1"));

        Assert.Equal("aws", CloudRegion.GetFromEnv(env).Provider);
    }

    [Fact]
    public void EmptyStringsAreTreatedAsUnset()
    {
        Assert.Equal(new CloudRegionResult("unknown", "unknown"), CloudRegion.GetFromEnv(Env(("AWS_REGION", ""), ("AZURE_REGION", null))));
    }

    [Fact]
    public void DefaultsToUnknown()
    {
        Assert.Equal(new CloudRegionResult("unknown", "unknown"), CloudRegion.GetFromEnv(Env()));
    }
}
