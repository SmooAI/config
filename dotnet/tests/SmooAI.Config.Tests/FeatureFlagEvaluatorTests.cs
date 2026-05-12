using System.Net;
using System.Text.Json;
using SmooAI.Config.Models;
using SmooAI.Config.OAuth;
using SmooAI.Config.Typed;

namespace SmooAI.Config.Tests;

/// <summary>
/// SMOODEV-959 — segment-aware feature-flag evaluator parity with TS / Python /
/// Rust / Go. Fixtures mirror the existing Go (<c>feature_flag_evaluate_test.go</c>)
/// and Python (<c>test_client.py</c>) suites.
/// </summary>
public class FeatureFlagEvaluatorTests
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
        // Seed an OAuth token exchange so the first real request gets through.
        handler.Enqueue(HttpStatusCode.OK, """{"access_token":"tok-1","expires_in":3600}""");
        var options = Options();
        var tokenProvider = new TokenProvider(http, options.AuthUrl!, options.ClientId, options.ClientSecret);
        var client = new SmooConfigClient(options, http, tokenProvider);
        return (client, handler);
    }

    [Fact]
    public async Task EvaluateFeatureFlagAsync_posts_expected_body_and_headers()
    {
        var (client, handler) = CreateClient();
        handler.Enqueue(HttpStatusCode.OK, """{"value":true,"source":"rule","matchedRuleId":"r-1"}""");

        var context = new Dictionary<string, object?>
        {
            ["userId"] = "u-42",
            ["plan"] = "pro",
        };
        var resp = await client.EvaluateFeatureFlagAsync("newCheckout", context);

        Assert.Equal("rule", resp.Source);
        Assert.Equal("r-1", resp.MatchedRuleId);
        Assert.Equal(JsonValueKind.True, resp.Value.ValueKind);

        // token + POST
        Assert.Equal(2, handler.Requests.Count);
        var post = handler.Requests[1];
        Assert.Equal(HttpMethod.Post, post.Method);
        Assert.Equal(
            "https://api.smoo.ai/organizations/org-uuid/config/feature-flags/newCheckout/evaluate",
            post.RequestUri!.ToString());
        Assert.Equal("Bearer", post.Headers.Authorization!.Scheme);
        Assert.Equal("tok-1", post.Headers.Authorization!.Parameter);

        using var parsed = JsonDocument.Parse(handler.RequestBodies[1]);
        Assert.Equal("production", parsed.RootElement.GetProperty("environment").GetString());
        var ctx = parsed.RootElement.GetProperty("context");
        Assert.Equal("u-42", ctx.GetProperty("userId").GetString());
        Assert.Equal("pro", ctx.GetProperty("plan").GetString());
    }

    [Fact]
    public async Task EvaluateFeatureFlagAsync_null_context_serializes_as_empty_object()
    {
        var (client, handler) = CreateClient();
        handler.Enqueue(HttpStatusCode.OK, """{"value":false,"source":"default"}""");

        await client.EvaluateFeatureFlagAsync("flag");

        using var parsed = JsonDocument.Parse(handler.RequestBodies[1]);
        var ctx = parsed.RootElement.GetProperty("context");
        Assert.Equal(JsonValueKind.Object, ctx.ValueKind);
        Assert.Empty(ctx.EnumerateObject());
    }

    [Fact]
    public async Task EvaluateFeatureFlagAsync_override_environment_wins()
    {
        var (client, handler) = CreateClient();
        handler.Enqueue(HttpStatusCode.OK, """{"value":1,"source":"raw"}""");

        await client.EvaluateFeatureFlagAsync("flag", null, "staging");

        using var parsed = JsonDocument.Parse(handler.RequestBodies[1]);
        Assert.Equal("staging", parsed.RootElement.GetProperty("environment").GetString());
    }

    [Fact]
    public async Task EvaluateFeatureFlagAsync_url_encodes_key()
    {
        var (client, handler) = CreateClient();
        handler.Enqueue(HttpStatusCode.OK, """{"value":true,"source":"raw"}""");

        await client.EvaluateFeatureFlagAsync("weird/key");

        var post = handler.Requests[1];
        // Slash must be escaped so the path segment is preserved as a single
        // value rather than being interpreted as a sub-route.
        Assert.Contains("feature-flags/weird%2Fkey/evaluate", post.RequestUri!.ToString());
    }

    [Fact]
    public async Task EvaluateFeatureFlagAsync_decodes_full_response_shape()
    {
        var (client, handler) = CreateClient();
        handler.Enqueue(HttpStatusCode.OK, """{"value":{"variant":"B"},"source":"rollout","matchedRuleId":"r-2","rolloutBucket":42}""");

        var resp = await client.EvaluateFeatureFlagAsync("flag");

        Assert.Equal("rollout", resp.Source);
        Assert.Equal("r-2", resp.MatchedRuleId);
        Assert.Equal(42, resp.RolloutBucket);
        Assert.Equal("B", resp.Value.GetProperty("variant").GetString());
    }

    [Fact]
    public async Task EvaluateFeatureFlagAsync_404_throws_not_found()
    {
        var (client, handler) = CreateClient();
        handler.Enqueue(HttpStatusCode.NotFound, "flag not defined in schema");

        var ex = await Assert.ThrowsAsync<FeatureFlagEvaluationException>(() =>
            client.EvaluateFeatureFlagAsync("missing"));

        Assert.Equal("missing", ex.Key);
        Assert.Equal(404, ex.StatusCode);
        Assert.Equal(FeatureFlagErrorKind.NotFound, ex.Kind);
        Assert.Equal("flag not defined in schema", ex.ServerMessage);
    }

    [Fact]
    public async Task EvaluateFeatureFlagAsync_400_throws_context()
    {
        var (client, handler) = CreateClient();
        handler.Enqueue(HttpStatusCode.BadRequest, "missing environment");

        var ex = await Assert.ThrowsAsync<FeatureFlagEvaluationException>(() =>
            client.EvaluateFeatureFlagAsync("flag"));
        Assert.Equal(FeatureFlagErrorKind.Context, ex.Kind);
        Assert.Equal(400, ex.StatusCode);
    }

    [Fact]
    public async Task EvaluateFeatureFlagAsync_500_throws_server()
    {
        var (client, handler) = CreateClient();
        handler.Enqueue(HttpStatusCode.InternalServerError, "boom");

        var ex = await Assert.ThrowsAsync<FeatureFlagEvaluationException>(() =>
            client.EvaluateFeatureFlagAsync("flag"));
        Assert.Equal(FeatureFlagErrorKind.Server, ex.Kind);
        Assert.Equal(500, ex.StatusCode);
        Assert.Contains("boom", ex.Message);
    }

    [Fact]
    public async Task EvaluateFeatureFlagAsync_throws_on_empty_key()
    {
        var (client, _) = CreateClient();
        await Assert.ThrowsAsync<ArgumentException>(() => client.EvaluateFeatureFlagAsync(""));
    }

    // --- ConfigKey<T>.EvaluateAsync wiring ---

    [Fact]
    public async Task ConfigKey_EvaluateAsync_returns_typed_value_for_feature_flag_tier()
    {
        var (client, handler) = CreateClient();
        handler.Enqueue(HttpStatusCode.OK, """{"value":true,"source":"rule"}""");

        var key = new ConfigKey<bool>("newCheckout", ConfigTier.FeatureFlag);
        var value = await key.EvaluateAsync(client, new Dictionary<string, object?> { ["userId"] = "u-1" });
        Assert.True(value);
    }

    [Fact]
    public async Task ConfigKey_EvaluateAsync_throws_for_non_feature_flag_tier()
    {
        var (client, _) = CreateClient();
        var key = new ConfigKey<string>("apiUrl", ConfigTier.Public);
        await Assert.ThrowsAsync<InvalidOperationException>(() => key.EvaluateAsync(client));
    }

    [Fact]
    public async Task ConfigKey_EvaluateRawAsync_exposes_full_envelope()
    {
        var (client, handler) = CreateClient();
        handler.Enqueue(HttpStatusCode.OK, """{"value":"variantA","source":"rollout","matchedRuleId":"r-7","rolloutBucket":3}""");

        var key = new ConfigKey<string>("checkoutVariant", ConfigTier.FeatureFlag);
        var resp = await key.EvaluateRawAsync(client);
        Assert.Equal("rollout", resp.Source);
        Assert.Equal("r-7", resp.MatchedRuleId);
        Assert.Equal(3, resp.RolloutBucket);
        Assert.Equal("variantA", resp.Value.GetString());
    }
}
