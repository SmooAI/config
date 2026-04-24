using System.Net;
using System.Text;
using System.Text.Json;
using SmooAI.Config.Build;
using SmooAI.Config.Models;
using SmooAI.Config.OAuth;
using SmooAI.Config.Runtime;
using SmooAI.Config.Typed;

namespace SmooAI.Config.Tests;

public class ConfigKeyTests
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
    public async Task GetAsync_DeserializesString()
    {
        var (client, handler) = CreateClient();
        handler.Enqueue(HttpStatusCode.OK, """{"value":"sk-abc"}""");

        var key = new ConfigKey<string>("moonshotApiKey", ConfigTier.Secret);
        var value = await key.GetAsync(client);
        Assert.Equal("sk-abc", value);
    }

    [Fact]
    public async Task GetAsync_DeserializesBool()
    {
        var (client, handler) = CreateClient();
        handler.Enqueue(HttpStatusCode.OK, """{"value":true}""");

        var key = new ConfigKey<bool>("newFlow", ConfigTier.FeatureFlag);
        var value = await key.GetAsync(client);
        Assert.True(value);
    }

    [Fact]
    public void Get_FromRuntime_Deserializes()
    {
        var payload = Encoding.UTF8.GetBytes("""{"public":{"apiUrl":"https://api.example.com","retries":5}}""");
        var (bundle, keyB64) = SmooConfigBuilder.Encrypt(payload);
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".enc");
        File.WriteAllBytes(path, bundle);

        try
        {
            var runtime = SmooConfigRuntime.LoadFrom(path, keyB64);

            var url = new ConfigKey<string>("apiUrl", ConfigTier.Public);
            Assert.Equal("https://api.example.com", url.Get(runtime));

            var retries = new ConfigKey<int>("retries", ConfigTier.Public);
            Assert.Equal(5, retries.Get(runtime));

            var missing = new ConfigKey<string>("missing", ConfigTier.Public);
            Assert.Null(missing.Get(runtime));

            // Null runtime is tolerated and returns default.
            Assert.Null(url.Get(null));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public async Task ResolveAsync_PrefersRuntimeOverClient()
    {
        var payload = Encoding.UTF8.GetBytes("""{"public":{"apiUrl":"https://baked.example.com"}}""");
        var (bundle, keyB64) = SmooConfigBuilder.Encrypt(payload);
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".enc");
        File.WriteAllBytes(path, bundle);

        try
        {
            var runtime = SmooConfigRuntime.LoadFrom(path, keyB64);
            var (client, _) = CreateClient();
            // No additional response queued — client must NOT be called.

            var key = new ConfigKey<string>("apiUrl", ConfigTier.Public);
            var value = await key.ResolveAsync(runtime, client);
            Assert.Equal("https://baked.example.com", value);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public async Task ResolveAsync_FallsBackToClientWhenRuntimeMissingKey()
    {
        var payload = Encoding.UTF8.GetBytes("""{"public":{}}""");
        var (bundle, keyB64) = SmooConfigBuilder.Encrypt(payload);
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".enc");
        File.WriteAllBytes(path, bundle);

        try
        {
            var runtime = SmooConfigRuntime.LoadFrom(path, keyB64);
            var (client, handler) = CreateClient();
            handler.Enqueue(HttpStatusCode.OK, """{"value":"flagged-on"}""");

            var key = new ConfigKey<string>("newFlow", ConfigTier.FeatureFlag);
            var value = await key.ResolveAsync(runtime, client);
            Assert.Equal("flagged-on", value);
        }
        finally
        {
            File.Delete(path);
        }
    }
}
