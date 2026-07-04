using System.Net;
using System.Text.Json;
using SmooAI.Config.Models;
using SmooAI.Config.OAuth;

namespace SmooAI.Config.Tests;

/// <summary>
/// SMOODEV-2306 — segment-aware limit evaluator + clamp. Mirrors
/// <c>FeatureFlagEvaluatorTests</c> and the Go / Python / Rust suites.
/// </summary>
public class LimitEvaluatorTests
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
    public async Task EvaluateLimitAsync_posts_expected_body_and_returns_numeric_value()
    {
        var (client, handler) = CreateClient();
        handler.Enqueue(HttpStatusCode.OK, """{"value":20,"source":"rule","matchedRuleId":"r-9"}""");

        var context = new Dictionary<string, object?> { ["orgId"] = "o-1", ["agentId"] = "a-1" };
        var resp = await client.EvaluateLimitAsync("agentMaxIterations", context);

        Assert.Equal(20d, resp.Value);
        Assert.Equal("rule", resp.Source);
        Assert.Equal("r-9", resp.MatchedRuleId);

        Assert.Equal(2, handler.Requests.Count);
        var post = handler.Requests[1];
        Assert.Equal(HttpMethod.Post, post.Method);
        Assert.Equal(
            "https://api.smoo.ai/organizations/org-uuid/config/limits/agentMaxIterations/evaluate",
            post.RequestUri!.ToString());

        using var parsed = JsonDocument.Parse(handler.RequestBodies[1]);
        Assert.Equal("production", parsed.RootElement.GetProperty("environment").GetString());
        Assert.Equal("o-1", parsed.RootElement.GetProperty("context").GetProperty("orgId").GetString());
    }

    [Fact]
    public async Task EvaluateLimitAsync_404_throws_not_found()
    {
        var (client, handler) = CreateClient();
        handler.Enqueue(HttpStatusCode.NotFound, "limit not defined in schema");

        var ex = await Assert.ThrowsAsync<LimitEvaluationException>(() =>
            client.EvaluateLimitAsync("missing"));

        Assert.Equal("missing", ex.Key);
        Assert.Equal(404, ex.StatusCode);
        Assert.Equal(LimitErrorKind.NotFound, ex.Kind);
    }

    [Fact]
    public async Task EvaluateLimitAsync_400_and_500_categorize()
    {
        var (client1, handler1) = CreateClient();
        handler1.Enqueue(HttpStatusCode.BadRequest, "missing environment");
        var ctxEx = await Assert.ThrowsAsync<LimitEvaluationException>(() => client1.EvaluateLimitAsync("limit"));
        Assert.Equal(LimitErrorKind.Context, ctxEx.Kind);

        var (client2, handler2) = CreateClient();
        handler2.Enqueue(HttpStatusCode.InternalServerError, "boom");
        var srvEx = await Assert.ThrowsAsync<LimitEvaluationException>(() => client2.EvaluateLimitAsync("limit"));
        Assert.Equal(LimitErrorKind.Server, srvEx.Kind);
        Assert.Equal(500, srvEx.StatusCode);
    }

    [Fact]
    public async Task EvaluateLimitAsync_throws_on_empty_key()
    {
        var (client, _) = CreateClient();
        await Assert.ThrowsAsync<ArgumentException>(() => client.EvaluateLimitAsync(""));
    }

    [Theory]
    [InlineData(20, 20)]
    [InlineData(-5, 1)]
    [InlineData(1000, 50)]
    [InlineData(double.NaN, 12)]
    [InlineData(double.PositiveInfinity, 12)]
    public void LimitSpec_Clamp_bounds_and_fallback(double raw, double expected)
    {
        var spec = new LimitSpec(Default: 12, Min: 1, Max: 50);
        Assert.Equal(expected, spec.Clamp(raw));
    }

    [Theory]
    [InlineData(12, 10)]
    [InlineData(13, 15)]
    public void LimitSpec_Clamp_snaps_to_step(double raw, double expected)
    {
        var spec = new LimitSpec(Default: 10, Min: 0, Max: 100, Step: 5);
        Assert.Equal(expected, spec.Clamp(raw));
    }
}
