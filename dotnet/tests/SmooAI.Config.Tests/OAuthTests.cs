using System.Net;
using SmooAI.Config.OAuth;

namespace SmooAI.Config.Tests;

public class OAuthTests
{
    private static (HttpClient client, StubHttpMessageHandler handler) CreateHttp()
    {
        var handler = new StubHttpMessageHandler();
        var client = new HttpClient(handler);
        return (client, handler);
    }

    [Fact]
    public async Task GetAccessTokenAsync_exchanges_credentials_and_returns_token()
    {
        var (http, handler) = CreateHttp();
        handler.Enqueue(HttpStatusCode.OK, """{"access_token":"tok-abc","token_type":"Bearer","expires_in":3600}""");

        var provider = new TokenProvider(http, "https://auth.smoo.ai", "client-id", "client-secret");
        var token = await provider.GetAccessTokenAsync();

        Assert.Equal("tok-abc", token);
        var request = Assert.Single(handler.Requests);
        Assert.Equal(HttpMethod.Post, request.Method);
        Assert.Equal("https://auth.smoo.ai/token", request.RequestUri!.ToString());
        Assert.Equal("application/x-www-form-urlencoded", request.Content!.Headers.ContentType!.MediaType);

        var body = Assert.Single(handler.RequestBodies);
        Assert.Contains("grant_type=client_credentials", body);
        Assert.Contains("provider=client_credentials", body);
        Assert.Contains("client_id=client-id", body);
        Assert.Contains("client_secret=client-secret", body);
    }

    [Fact]
    public async Task GetAccessTokenAsync_caches_token_until_refresh_window()
    {
        var (http, handler) = CreateHttp();
        handler.Enqueue(HttpStatusCode.OK, """{"access_token":"tok-1","expires_in":3600}""");

        var now = DateTimeOffset.UtcNow;
        var provider = new TokenProvider(http, "https://auth.smoo.ai", "cid", "csec") { UtcNow = () => now };

        Assert.Equal("tok-1", await provider.GetAccessTokenAsync());
        // Second call within expiry window should NOT hit the server.
        Assert.Equal("tok-1", await provider.GetAccessTokenAsync());

        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task GetAccessTokenAsync_refreshes_near_expiry()
    {
        var (http, handler) = CreateHttp();
        handler.Enqueue(HttpStatusCode.OK, """{"access_token":"tok-1","expires_in":120}""");
        handler.Enqueue(HttpStatusCode.OK, """{"access_token":"tok-2","expires_in":3600}""");

        var now = DateTimeOffset.UtcNow;
        var provider = new TokenProvider(http, "https://auth.smoo.ai", "cid", "csec", TimeSpan.FromSeconds(60))
        {
            UtcNow = () => now,
        };

        Assert.Equal("tok-1", await provider.GetAccessTokenAsync());
        // Jump close to expiry (120s issued, 60s refresh window → refresh at t+60)
        now = now.AddSeconds(61);
        Assert.Equal("tok-2", await provider.GetAccessTokenAsync());
        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task GetAccessTokenAsync_throws_on_401()
    {
        var (http, handler) = CreateHttp();
        handler.Enqueue(HttpStatusCode.Unauthorized, """{"error":"invalid_client"}""");

        var provider = new TokenProvider(http, "https://auth.smoo.ai", "cid", "csec");
        var ex = await Assert.ThrowsAsync<TokenExchangeException>(() => provider.GetAccessTokenAsync());
        Assert.Equal(401, ex.StatusCode);
        Assert.Contains("HTTP 401", ex.Message);
        Assert.Contains("client_id and client_secret", ex.Message);
    }

    [Fact]
    public async Task GetAccessTokenAsync_throws_on_missing_access_token()
    {
        var (http, handler) = CreateHttp();
        handler.Enqueue(HttpStatusCode.OK, """{"token_type":"Bearer","expires_in":3600}""");

        var provider = new TokenProvider(http, "https://auth.smoo.ai", "cid", "csec");
        var ex = await Assert.ThrowsAsync<TokenExchangeException>(() => provider.GetAccessTokenAsync());
        Assert.Contains("missing access_token", ex.Message);
    }

    [Fact]
    public async Task Invalidate_forces_next_call_to_refresh()
    {
        var (http, handler) = CreateHttp();
        handler.Enqueue(HttpStatusCode.OK, """{"access_token":"tok-1","expires_in":3600}""");
        handler.Enqueue(HttpStatusCode.OK, """{"access_token":"tok-2","expires_in":3600}""");

        var provider = new TokenProvider(http, "https://auth.smoo.ai", "cid", "csec");
        Assert.Equal("tok-1", await provider.GetAccessTokenAsync());
        provider.Invalidate();
        Assert.Equal("tok-2", await provider.GetAccessTokenAsync());
        Assert.Equal(2, handler.Requests.Count);
    }

    [Theory]
    [InlineData("https://api.smoo.ai", "https://auth.smoo.ai")]
    [InlineData("https://api.dev.smooai.dev", "https://auth.dev.smooai.dev")]
    [InlineData("https://localhost:3000", "https://localhost:3000")]
    public void DeriveAuthUrl_swaps_api_subdomain(string baseUrl, string expected)
    {
        Assert.Equal(expected, SmooConfigClientOptions.DeriveAuthUrl(baseUrl));
    }
}
