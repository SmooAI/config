using System.Net;
using System.Text.Json;
using SmooAI.Config.Bootstrap;

namespace SmooAI.Config.Tests.Bootstrap;

[Collection("BootstrapCache")]
public class BootstrapFetchTests
{
    private static (HttpClient client, StubHttpMessageHandler handler) CreateHttp()
    {
        var handler = new StubHttpMessageHandler();
        var client = new HttpClient(handler);
        return (client, handler);
    }

    private static Func<string, string?> Env(params (string Key, string Value)[] pairs)
    {
        var map = pairs.ToDictionary(p => p.Key, p => p.Value);
        return k => map.TryGetValue(k, out var v) ? v : null;
    }

    private static (string Key, string Value)[] BaseEnv() => new[]
    {
        ("SMOOAI_CONFIG_API_URL", "https://api.example.test"),
        ("SMOOAI_CONFIG_AUTH_URL", "https://auth.example.test"),
        ("SMOOAI_CONFIG_CLIENT_ID", "client-id-123"),
        ("SMOOAI_CONFIG_CLIENT_SECRET", "client-secret-456"),
        ("SMOOAI_CONFIG_ORG_ID", "org-789"),
    };

    public BootstrapFetchTests()
    {
        SmooAI.Config.Bootstrap.Bootstrap.ResetCache();
    }

    [Fact]
    public async Task ReturnsValueForKnownKey()
    {
        var (http, handler) = CreateHttp();
        handler.Enqueue(HttpStatusCode.OK, """{"access_token":"TOKEN"}""");
        handler.Enqueue(HttpStatusCode.OK, """{"values":{"databaseUrl":"postgres://x"}}""");

        var value = await SmooAI.Config.Bootstrap.Bootstrap.FetchAsync(
            "databaseUrl",
            new BootstrapOptions { HttpClient = http, GetEnv = Env(BaseEnv()) });
        Assert.Equal("postgres://x", value);
        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task ReturnsNullForMissingKey()
    {
        var (http, handler) = CreateHttp();
        handler.Enqueue(HttpStatusCode.OK, """{"access_token":"T"}""");
        handler.Enqueue(HttpStatusCode.OK, """{"values":{"other":"x"}}""");

        var value = await SmooAI.Config.Bootstrap.Bootstrap.FetchAsync(
            "databaseUrl",
            new BootstrapOptions { HttpClient = http, GetEnv = Env(BaseEnv()) });
        Assert.Null(value);
    }

    [Fact]
    public async Task CachesValuesPerEnv()
    {
        var (http, handler) = CreateHttp();
        handler.Enqueue(HttpStatusCode.OK, """{"access_token":"T"}""");
        handler.Enqueue(HttpStatusCode.OK, """{"values":{"a":"1","b":"2"}}""");

        var options = new BootstrapOptions { HttpClient = http, GetEnv = Env(BaseEnv()) };
        Assert.Equal("1", await SmooAI.Config.Bootstrap.Bootstrap.FetchAsync("a", options));
        Assert.Equal("2", await SmooAI.Config.Bootstrap.Bootstrap.FetchAsync("b", options));
        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task RefetchesOnEnvChange()
    {
        var (http, handler) = CreateHttp();
        handler.Enqueue(HttpStatusCode.OK, """{"access_token":"T1"}""");
        handler.Enqueue(HttpStatusCode.OK, """{"values":{"a":"dev"}}""");
        handler.Enqueue(HttpStatusCode.OK, """{"access_token":"T2"}""");
        handler.Enqueue(HttpStatusCode.OK, """{"values":{"a":"prod"}}""");

        var envFn = Env(BaseEnv());
        Assert.Equal("dev", await SmooAI.Config.Bootstrap.Bootstrap.FetchAsync(
            "a", new BootstrapOptions { HttpClient = http, GetEnv = envFn, Environment = "development" }));
        Assert.Equal("prod", await SmooAI.Config.Bootstrap.Bootstrap.FetchAsync(
            "a", new BootstrapOptions { HttpClient = http, GetEnv = envFn, Environment = "production" }));
        Assert.Equal(4, handler.Requests.Count);
    }

    [Fact]
    public async Task OAuthRequestShape()
    {
        var (http, handler) = CreateHttp();
        handler.Enqueue(HttpStatusCode.OK, """{"access_token":"TOKEN"}""");
        handler.Enqueue(HttpStatusCode.OK, """{"values":{"k":"v"}}""");

        await SmooAI.Config.Bootstrap.Bootstrap.FetchAsync(
            "k", new BootstrapOptions { HttpClient = http, GetEnv = Env(BaseEnv()) });

        var auth = handler.Requests[0];
        Assert.Equal(HttpMethod.Post, auth.Method);
        Assert.Equal("https://auth.example.test/token", auth.RequestUri!.ToString());
        Assert.Equal("application/x-www-form-urlencoded", auth.Content!.Headers.ContentType!.MediaType);
        var body = handler.RequestBodies[0];
        Assert.Contains("grant_type=client_credentials", body);
        Assert.Contains("client_id=client-id-123", body);
        Assert.Contains("client_secret=client-secret-456", body);
        Assert.Contains("provider=client_credentials", body);
    }

    [Fact]
    public async Task ValuesRequestShape()
    {
        var (http, handler) = CreateHttp();
        handler.Enqueue(HttpStatusCode.OK, """{"access_token":"TOKEN"}""");
        handler.Enqueue(HttpStatusCode.OK, """{"values":{"k":"v"}}""");

        await SmooAI.Config.Bootstrap.Bootstrap.FetchAsync(
            "k",
            new BootstrapOptions { HttpClient = http, GetEnv = Env(BaseEnv()), Environment = "staging env" });

        var values = handler.Requests[1];
        Assert.Equal(HttpMethod.Get, values.Method);
        Assert.Equal(
            "https://api.example.test/organizations/org-789/config/values?environment=staging%20env",
            values.RequestUri!.AbsoluteUri);
        Assert.Equal("Bearer", values.Headers.Authorization!.Scheme);
        Assert.Equal("TOKEN", values.Headers.Authorization.Parameter);
    }

    [Fact]
    public async Task MissingCredsThrows()
    {
        var (http, _) = CreateHttp();
        var env = BaseEnv().Where(p => p.Key != "SMOOAI_CONFIG_CLIENT_ID").ToArray();
        var ex = await Assert.ThrowsAsync<BootstrapException>(() =>
            SmooAI.Config.Bootstrap.Bootstrap.FetchAsync("k",
                new BootstrapOptions { HttpClient = http, GetEnv = Env(env) }));
        Assert.Contains("CLIENT_ID,CLIENT_SECRET,ORG_ID", ex.Message);
    }

    [Fact]
    public async Task AcceptsLegacyApiKey()
    {
        var (http, handler) = CreateHttp();
        handler.Enqueue(HttpStatusCode.OK, """{"access_token":"T"}""");
        handler.Enqueue(HttpStatusCode.OK, """{"values":{"k":"v"}}""");

        var env = BaseEnv().Where(p => p.Key != "SMOOAI_CONFIG_CLIENT_SECRET")
            .Append(("SMOOAI_CONFIG_API_KEY", "legacy-secret")).ToArray();

        var value = await SmooAI.Config.Bootstrap.Bootstrap.FetchAsync(
            "k", new BootstrapOptions { HttpClient = http, GetEnv = Env(env) });
        Assert.Equal("v", value);
        Assert.Contains("client_secret=legacy-secret", handler.RequestBodies[0]);
    }

    [Fact]
    public async Task AcceptsLegacyAuthUrl()
    {
        var (http, handler) = CreateHttp();
        handler.Enqueue(HttpStatusCode.OK, """{"access_token":"T"}""");
        handler.Enqueue(HttpStatusCode.OK, """{"values":{"k":"v"}}""");

        var env = BaseEnv().Where(p => p.Key != "SMOOAI_CONFIG_AUTH_URL")
            .Append(("SMOOAI_AUTH_URL", "https://legacy-auth.example.test")).ToArray();

        await SmooAI.Config.Bootstrap.Bootstrap.FetchAsync(
            "k", new BootstrapOptions { HttpClient = http, GetEnv = Env(env) });
        Assert.Equal("https://legacy-auth.example.test/token", handler.Requests[0].RequestUri!.ToString());
    }

    [Fact]
    public async Task OAuthFailureThrows()
    {
        var (http, handler) = CreateHttp();
        handler.Enqueue(HttpStatusCode.Unauthorized, "invalid_client", "text/plain");
        var ex = await Assert.ThrowsAsync<BootstrapException>(() =>
            SmooAI.Config.Bootstrap.Bootstrap.FetchAsync("k",
                new BootstrapOptions { HttpClient = http, GetEnv = Env(BaseEnv()) }));
        Assert.Contains("OAuth token exchange failed: HTTP 401", ex.Message);
    }

    [Fact]
    public async Task ValuesFailureThrows()
    {
        var (http, handler) = CreateHttp();
        handler.Enqueue(HttpStatusCode.OK, """{"access_token":"T"}""");
        handler.Enqueue(HttpStatusCode.InternalServerError, "boom", "text/plain");

        var ex = await Assert.ThrowsAsync<BootstrapException>(() =>
            SmooAI.Config.Bootstrap.Bootstrap.FetchAsync("k",
                new BootstrapOptions { HttpClient = http, GetEnv = Env(BaseEnv()) }));
        Assert.Contains("GET /config/values failed: HTTP 500", ex.Message);
    }

    [Fact]
    public async Task OAuthMissingAccessTokenThrows()
    {
        var (http, handler) = CreateHttp();
        handler.Enqueue(HttpStatusCode.OK, "{}");
        var ex = await Assert.ThrowsAsync<BootstrapException>(() =>
            SmooAI.Config.Bootstrap.Bootstrap.FetchAsync("k",
                new BootstrapOptions { HttpClient = http, GetEnv = Env(BaseEnv()) }));
        Assert.Contains("no access_token", ex.Message);
    }

    [Theory]
    [InlineData("explicit", new[] { "SST_STAGE", "ignored" }, "explicit")]
    [InlineData(null, new[] { "SST_STAGE", "brentrager" }, "brentrager")]
    [InlineData(null, new[] { "NEXT_PUBLIC_SST_STAGE", "dev-stage" }, "dev-stage")]
    [InlineData(null, new[] { "SST_RESOURCE_App", "{\"stage\":\"sst-resource-stage\"}" }, "sst-resource-stage")]
    [InlineData(null, new[] { "SST_STAGE", "production" }, "production")]
    [InlineData(null, new[] { "SMOOAI_CONFIG_ENV", "qa" }, "qa")]
    [InlineData(null, new string[0], "development")]
    [InlineData(null, new[] { "SST_RESOURCE_App", "{not json", "SMOOAI_CONFIG_ENV", "qa" }, "qa")]
    public void ResolveEnv_Variants(string? explicitEnv, string[] envPairs, string expected)
    {
        var pairs = new List<(string, string)>();
        for (var i = 0; i + 1 < envPairs.Length; i += 2)
        {
            pairs.Add((envPairs[i], envPairs[i + 1]));
        }
        var resolved = SmooAI.Config.Bootstrap.Bootstrap.ResolveEnv(Env(pairs.ToArray()), explicitEnv);
        Assert.Equal(expected, resolved);
    }

    [Fact]
    public async Task StringifiesNonStringValues()
    {
        var (http, handler) = CreateHttp();
        handler.Enqueue(HttpStatusCode.OK, """{"access_token":"T"}""");
        handler.Enqueue(HttpStatusCode.OK, """{"values":{"count":42,"flag":true,"pi":3.5}}""");

        var options = new BootstrapOptions { HttpClient = http, GetEnv = Env(BaseEnv()) };
        Assert.Equal("42", await SmooAI.Config.Bootstrap.Bootstrap.FetchAsync("count", options));
        Assert.Equal("true", await SmooAI.Config.Bootstrap.Bootstrap.FetchAsync("flag", options));
        Assert.Equal("3.5", await SmooAI.Config.Bootstrap.Bootstrap.FetchAsync("pi", options));
    }
}

[CollectionDefinition("BootstrapCache", DisableParallelization = true)]
public class BootstrapCacheCollection { }
