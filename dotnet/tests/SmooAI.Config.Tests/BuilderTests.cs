using System.Net;
using System.Text.Json;
using SmooAI.Config.Build;
using SmooAI.Config.OAuth;
using SmooAI.Config.Runtime;

namespace SmooAI.Config.Tests;

public class BuilderTests
{
    private static SmooConfigClientOptions Options() => new()
    {
        ClientId = "cid",
        ClientSecret = "csec",
        OrgId = "org-uuid",
        BaseUrl = "https://api.smoo.ai",
        AuthUrl = "https://auth.smoo.ai",
        DefaultEnvironment = "production",
    };

    private static (SmooConfigClient client, StubHttpMessageHandler handler) CreateClient()
    {
        var handler = new StubHttpMessageHandler();
        var http = new HttpClient(handler);
        handler.Enqueue(HttpStatusCode.OK, """{"access_token":"tok-1","expires_in":3600}""");
        var options = Options();
        var tokenProvider = new TokenProvider(http, options.AuthUrl!, options.ClientId, options.ClientSecret);
        var client = new SmooConfigClient(options, http, tokenProvider);
        return (client, handler);
    }

    [Fact]
    public async Task BuildAsync_PartitionsByClassifier_AndEncryptsRoundTrip()
    {
        var (client, handler) = CreateClient();
        handler.Enqueue(HttpStatusCode.OK, """
            {"values":{"apiUrl":"https://api.example.com","dbPassword":"s3cr3t","newFlow":true}}
            """);

        var classify = SchemaClassifier.FromKeys(
            publicKeys: new[] { "apiUrl" },
            secretKeys: new[] { "dbPassword" },
            featureFlagKeys: new[] { "newFlow" });

        var result = await SmooConfigBuilder.BuildAsync(client, new BuildBundleOptions
        {
            Environment = "test",
            Classify = classify,
        });

        Assert.Equal(2, result.KeyCount);
        Assert.Equal(1, result.SkippedCount);
        Assert.Equal(32, Convert.FromBase64String(result.KeyB64).Length);

        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".enc");
        File.WriteAllBytes(path, result.Bundle);

        try
        {
            var runtime = SmooConfigRuntime.LoadFrom(path, result.KeyB64);
            Assert.Equal("https://api.example.com", runtime.GetPublic("apiUrl")!.Value.GetString());
            Assert.Equal("s3cr3t", runtime.GetSecret("dbPassword")!.Value.GetString());
            // Feature flag was skipped, so it's absent from both partitions.
            Assert.Null(runtime.GetPublic("newFlow"));
            Assert.Null(runtime.GetSecret("newFlow"));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public async Task BuildAsync_DefaultClassifier_PutsEverythingInPublic()
    {
        var (client, handler) = CreateClient();
        handler.Enqueue(HttpStatusCode.OK, """{"values":{"a":"1","b":"2"}}""");

        var result = await SmooConfigBuilder.BuildAsync(client, new BuildBundleOptions
        {
            Environment = "test",
        });

        Assert.Equal(2, result.KeyCount);
        Assert.Equal(0, result.SkippedCount);

        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".enc");
        File.WriteAllBytes(path, result.Bundle);
        try
        {
            var runtime = SmooConfigRuntime.LoadFrom(path, result.KeyB64);
            Assert.Equal(2, runtime.Baked.Public.Count);
            Assert.Empty(runtime.Baked.Secret);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void SchemaClassifier_FromJsonSchemaShape()
    {
        var schema = """
            {
              "$schema": "http://json-schema.org/draft-07/schema#",
              "type": "object",
              "properties": {
                "public": { "type": "object", "properties": { "apiUrl": {"type":"string"} } },
                "secret": { "type": "object", "properties": { "dbPassword": {"type":"string"} } },
                "featureFlags": { "type": "object", "properties": { "newFlow": {"type":"boolean"} } }
              }
            }
            """;
        var classify = SchemaClassifier.FromSchemaJson(schema);
        Assert.Equal(ClassifyResult.Public, classify("apiUrl", default));
        Assert.Equal(ClassifyResult.Secret, classify("dbPassword", default));
        Assert.Equal(ClassifyResult.Skip, classify("newFlow", default));
        Assert.Equal(ClassifyResult.Public, classify("unknown", default));
    }

    [Fact]
    public void SchemaClassifier_FromSerializedDefineConfigShape()
    {
        var schema = """
            {
              "publicConfigSchema": { "apiUrl": "stringSchema" },
              "secretConfigSchema": { "dbPassword": "stringSchema" },
              "featureFlagSchema":  { "newFlow":    "booleanSchema" }
            }
            """;
        var classify = SchemaClassifier.FromSchemaJson(schema);
        Assert.Equal(ClassifyResult.Public, classify("apiUrl", default));
        Assert.Equal(ClassifyResult.Secret, classify("dbPassword", default));
        Assert.Equal(ClassifyResult.Skip, classify("newFlow", default));
    }

    [Fact]
    public void SchemaClassifier_FromSchemaFile()
    {
        var schema = """
            {
              "publicConfigSchema": { "apiUrl": "stringSchema" }
            }
            """;
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".json");
        File.WriteAllText(path, schema);
        try
        {
            var classify = SchemaClassifier.FromSchemaFile(path);
            Assert.Equal(ClassifyResult.Public, classify("apiUrl", default));
        }
        finally
        {
            File.Delete(path);
        }
    }
}
