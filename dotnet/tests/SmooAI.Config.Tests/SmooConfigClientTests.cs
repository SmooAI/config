using System.Net;
using System.Text.Json;
using SmooAI.Config.Models;
using SmooAI.Config.OAuth;

namespace SmooAI.Config.Tests;

public class SmooConfigClientTests
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

    private static (SmooConfigClient client, StubHttpMessageHandler handler, HttpClient http) CreateClient(Action<StubHttpMessageHandler>? seedToken = null)
    {
        var handler = new StubHttpMessageHandler();
        var http = new HttpClient(handler);
        // Default: seed an OAuth token exchange response (unless suppressed)
        if (seedToken is null)
        {
            handler.Enqueue(HttpStatusCode.OK, """{"access_token":"tok-1","expires_in":3600}""");
        }
        else
        {
            seedToken(handler);
        }
        var options = Options();
        var tokenProvider = new TokenProvider(http, options.AuthUrl!, options.ClientId, options.ClientSecret);
        var client = new SmooConfigClient(options, http, tokenProvider);
        return (client, handler, http);
    }

    [Fact]
    public async Task GetValueAsync_sends_authorized_get_and_parses_envelope()
    {
        var (client, handler, _) = CreateClient();
        handler.Enqueue(HttpStatusCode.OK, """{"value":"sk-abc123"}""");

        var value = await client.GetValueAsync("moonshotApiKey");

        Assert.Equal(JsonValueKind.String, value.ValueKind);
        Assert.Equal("sk-abc123", value.GetString());

        // 1st request = token, 2nd = actual GET
        Assert.Equal(2, handler.Requests.Count);
        var get = handler.Requests[1];
        Assert.Equal(HttpMethod.Get, get.Method);
        Assert.Equal("https://api.smoo.ai/organizations/org-uuid/config/values/moonshotApiKey?environment=production",
            get.RequestUri!.ToString());
        Assert.Equal("Bearer", get.Headers.Authorization!.Scheme);
        Assert.Equal("tok-1", get.Headers.Authorization!.Parameter);
    }

    [Fact]
    public async Task GetValueAsync_uses_override_environment()
    {
        var (client, handler, _) = CreateClient();
        handler.Enqueue(HttpStatusCode.OK, """{"value":42}""");

        await client.GetValueAsync("threshold", "staging");

        Assert.EndsWith("?environment=staging", handler.Requests[1].RequestUri!.ToString());
    }

    [Fact]
    public async Task GetValueAsync_retries_once_on_401()
    {
        var (client, handler, _) = CreateClient();
        // First GET → 401, then token refresh, then retry → 200
        handler.Enqueue(HttpStatusCode.Unauthorized, "unauthorized");
        handler.Enqueue(HttpStatusCode.OK, """{"access_token":"tok-2","expires_in":3600}""");
        handler.Enqueue(HttpStatusCode.OK, """{"value":"ok"}""");

        var value = await client.GetValueAsync("k");
        Assert.Equal("ok", value.GetString());
        // token1 + GET401 + token2 + GET200 = 4
        Assert.Equal(4, handler.Requests.Count);
        Assert.Equal("tok-2", handler.Requests[3].Headers.Authorization!.Parameter);
    }

    [Fact]
    public async Task GetValueAsync_throws_on_persistent_error()
    {
        var (client, handler, _) = CreateClient();
        handler.Enqueue(HttpStatusCode.InternalServerError, "boom");

        var ex = await Assert.ThrowsAsync<SmooConfigApiException>(() => client.GetValueAsync("k"));
        Assert.Equal(500, ex.StatusCode);
        Assert.Contains("HTTP 500", ex.Message);
    }

    [Fact]
    public async Task GetValueAsync_throws_on_missing_key_argument()
    {
        var (client, _, _) = CreateClient();
        await Assert.ThrowsAsync<ArgumentException>(() => client.GetValueAsync(""));
    }

    [Fact]
    public async Task GetAllValuesAsync_returns_values_map()
    {
        var (client, handler, _) = CreateClient();
        handler.Enqueue(HttpStatusCode.OK, """{"values":{"foo":"bar","n":1}}""");

        var all = await client.GetAllValuesAsync();

        Assert.Equal(2, all.Count);
        Assert.Equal("bar", all["foo"].GetString());
        Assert.Equal(1, all["n"].GetInt32());
    }

    [Fact]
    public async Task GetAllValuesAsync_throws_when_server_returns_success_false()
    {
        var (client, handler, _) = CreateClient();
        handler.Enqueue(HttpStatusCode.OK, """{"success":false,"error":"schema missing"}""");

        var ex = await Assert.ThrowsAsync<SmooConfigApiException>(() => client.GetAllValuesAsync());
        Assert.Contains("schema missing", ex.Message);
    }

    [Fact]
    public async Task SetValueAsync_sends_put_with_wire_body()
    {
        var (client, handler, _) = CreateClient();
        handler.Enqueue(HttpStatusCode.OK, "{}");

        await client.SetValueAsync(
            schemaId: "schema-uuid",
            environmentId: "env-uuid",
            key: "moonshotApiKey",
            value: "sk-xyz",
            tier: ConfigTier.Secret);

        var put = handler.Requests[1];
        Assert.Equal(HttpMethod.Put, put.Method);
        Assert.Equal("https://api.smoo.ai/organizations/org-uuid/config/values", put.RequestUri!.ToString());

        using var parsed = JsonDocument.Parse(handler.RequestBodies[1]);
        Assert.Equal("schema-uuid", parsed.RootElement.GetProperty("schemaId").GetString());
        Assert.Equal("env-uuid", parsed.RootElement.GetProperty("environmentId").GetString());
        Assert.Equal("moonshotApiKey", parsed.RootElement.GetProperty("key").GetString());
        Assert.Equal("sk-xyz", parsed.RootElement.GetProperty("value").GetString());
        Assert.Equal("secret", parsed.RootElement.GetProperty("tier").GetString());
    }

    [Fact]
    public async Task SetValueAsync_encodes_featureFlag_tier_as_camelCase()
    {
        var (client, handler, _) = CreateClient();
        handler.Enqueue(HttpStatusCode.OK, "{}");

        await client.SetValueAsync("s", "e", "k", true, ConfigTier.FeatureFlag);

        using var parsed = JsonDocument.Parse(handler.RequestBodies[1]);
        Assert.Equal("featureFlag", parsed.RootElement.GetProperty("tier").GetString());
    }

    [Fact]
    public void Constructor_throws_on_missing_required_option()
    {
        Assert.Throws<ArgumentException>(() => new SmooConfigClient(new SmooConfigClientOptions
        {
            ClientSecret = "s",
            OrgId = "o",
        }));
    }
}
