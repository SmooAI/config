using System.Net;
using System.Text;
using System.Text.Json;
using SmooAI.Config.Build;
using SmooAI.Config.OAuth;
using SmooAI.Config.Runtime;

namespace SmooAI.Config.Tests;

/// <summary>
/// Integration tests for the .NET config priority chain.
/// Parity with TypeScript <c>src/server/server.priority-chain.integration.test.ts</c>,
/// adapted to the .NET architecture, which (per design) keeps the blob path
/// and the HTTP path independent — there is no <c>ConfigManager</c> that
/// merges <c>blob → env → HTTP → file</c>. The two paths must be exercised
/// separately:
/// <list type="bullet">
///   <item><see cref="SmooConfigRuntime"/> — decrypts a baked AES-256-GCM blob and serves public/secret synchronously, no network.</item>
///   <item><see cref="SmooConfigClient"/> — talks to the HTTP API for live values and feature flags.</item>
/// </list>
/// Coverage:
/// <list type="bullet">
///   <item>Blob: secret-over-public lookup precedence on collision.</item>
///   <item>Blob: missing key → null (no crash).</item>
///   <item>Blob: process bypasses HTTP entirely (no client construction needed).</item>
///   <item>HTTP: GetValue / GetAllValues round-trip with auth + env query.</item>
///   <item>HTTP: 5xx surfaces as <see cref="SmooConfigApiException"/> (no silent fall-through).</item>
///   <item>HTTP: explicit-environment override wins over default.</item>
/// </list>
/// </summary>
public class PriorityChainIntegrationTests : IDisposable
{
    private const string TestOrgId = "550e8400-e29b-41d4-a716-446655440000";
    private const string TestEnv = "production";

    public PriorityChainIntegrationTests() => SmooConfigRuntime.ResetForTests();
    public void Dispose() => SmooConfigRuntime.ResetForTests();

    // -----------------------------------------------------------------------
    // Blob path — SmooConfigRuntime resolves public + secret offline
    // -----------------------------------------------------------------------

    [Fact]
    public void Blob_PublicValueResolvesOffline()
    {
        var (path, keyB64) = WriteBlob(
            """{"public":{"apiUrl":"https://api.from-blob.example"},"secret":{"sendgridApiKey":"SG.from-blob"}}""");

        try
        {
            var runtime = SmooConfigRuntime.LoadFrom(path, keyB64);
            Assert.Equal("https://api.from-blob.example", runtime.GetPublic("apiUrl")!.Value.GetString());
            Assert.Equal("SG.from-blob", runtime.GetSecret("sendgridApiKey")!.Value.GetString());
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void Blob_SecretWinsOverPublicOnKeyCollision()
    {
        // Both partitions ship the same key — GetValue prefers the secret
        // tier, matching the TS/Python/Rust/Go merge order.
        var (path, keyB64) = WriteBlob(
            """{"public":{"apiKey":"public-value"},"secret":{"apiKey":"secret-value"}}""");

        try
        {
            var runtime = SmooConfigRuntime.LoadFrom(path, keyB64);
            Assert.Equal("secret-value", runtime.GetValue("apiKey")!.Value.GetString());
            // Direct accessors return their own partition's value.
            Assert.Equal("public-value", runtime.GetPublic("apiKey")!.Value.GetString());
            Assert.Equal("secret-value", runtime.GetSecret("apiKey")!.Value.GetString());
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void Blob_MissingKeyReturnsNull()
    {
        var (path, keyB64) = WriteBlob("""{"public":{"apiUrl":"only-this"},"secret":{}}""");

        try
        {
            var runtime = SmooConfigRuntime.LoadFrom(path, keyB64);
            Assert.Null(runtime.GetValue("missing"));
            Assert.Null(runtime.GetPublic("missing"));
            Assert.Null(runtime.GetSecret("missing"));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void Blob_PathDoesNotRequireHttpClient()
    {
        // The .NET architecture intentionally keeps SmooConfigRuntime
        // independent of SmooConfigClient — the blob path must never try to
        // reach the HTTP layer. This test pins that boundary by constructing
        // and reading from a runtime without ever instantiating a client.
        var (path, keyB64) = WriteBlob("""{"public":{"apiUrl":"https://api.example"},"secret":{}}""");

        try
        {
            var runtime = SmooConfigRuntime.LoadFrom(path, keyB64);
            Assert.NotNull(runtime);
            Assert.Equal("https://api.example", runtime.GetPublic("apiUrl")!.Value.GetString());
            // Sanity: no HttpClient field exists on the runtime; this assertion is
            // just here to make the architectural intent self-documenting in tests.
            var fields = runtime.GetType().GetFields(
                System.Reflection.BindingFlags.NonPublic |
                System.Reflection.BindingFlags.Instance);
            Assert.DoesNotContain(fields, f => f.FieldType == typeof(HttpClient));
        }
        finally
        {
            File.Delete(path);
        }
    }

    // -----------------------------------------------------------------------
    // HTTP path — SmooConfigClient talks to the live API
    // -----------------------------------------------------------------------

    [Fact]
    public async Task Http_GetValueAsyncReturnsValueWithEnvironmentParam()
    {
        var (client, handler, http) = CreateClient();
        try
        {
            handler.Enqueue(HttpStatusCode.OK, """{"value":"https://api.from-http.example"}""");

            var result = await client.GetValueAsync("apiUrl");
            Assert.Equal(JsonValueKind.String, result.ValueKind);
            Assert.Equal("https://api.from-http.example", result.GetString());

            // Token + GET = 2 requests; second carries the env query + Bearer header.
            Assert.Equal(2, handler.Requests.Count);
            var get = handler.Requests[1];
            Assert.EndsWith($"/organizations/{TestOrgId}/config/values/apiUrl?environment={TestEnv}", get.RequestUri!.AbsolutePath + get.RequestUri.Query);
            Assert.Equal("tok-1", get.Headers.Authorization!.Parameter);
        }
        finally
        {
            client.Dispose();
            http.Dispose();
        }
    }

    [Fact]
    public async Task Http_GetAllValuesAsyncReturnsValuesMap()
    {
        var (client, handler, http) = CreateClient();
        try
        {
            handler.Enqueue(HttpStatusCode.OK, """{"values":{"apiUrl":"https://api.example","retries":3}}""");

            var all = await client.GetAllValuesAsync();
            Assert.Equal(2, all.Count);
            Assert.Equal("https://api.example", all["apiUrl"].GetString());
            Assert.Equal(3, all["retries"].GetInt32());
        }
        finally
        {
            client.Dispose();
            http.Dispose();
        }
    }

    [Fact]
    public async Task Http_5xxThrowsSmooConfigApiException()
    {
        // Unlike the merge-pipeline languages, .NET surfaces HTTP failures
        // directly — there is no fall-through tier to consult. Pin that
        // contract so callers can rely on it for retry/circuit-breaker logic.
        var (client, handler, http) = CreateClient();
        try
        {
            handler.Enqueue(HttpStatusCode.InternalServerError, "boom");

            var ex = await Assert.ThrowsAsync<SmooConfigApiException>(() => client.GetValueAsync("apiUrl"));
            Assert.Equal(500, ex.StatusCode);
            Assert.Contains("HTTP 500", ex.Message);
        }
        finally
        {
            client.Dispose();
            http.Dispose();
        }
    }

    [Fact]
    public async Task Http_ExplicitEnvironmentOverridesDefault()
    {
        var (client, handler, http) = CreateClient();
        try
        {
            handler.Enqueue(HttpStatusCode.OK, """{"value":"staging-value"}""");

            await client.GetValueAsync("apiUrl", environment: "staging");

            Assert.EndsWith("?environment=staging", handler.Requests[1].RequestUri!.ToString());
        }
        finally
        {
            client.Dispose();
            http.Dispose();
        }
    }

    [Fact]
    public async Task Http_TokenInvalidationForcesReExchange()
    {
        // Caching parity with the TS chain — InvalidateToken drops the cached
        // OAuth credential so the next request triggers a new exchange. This
        // is the .NET analogue of `cfg.invalidateCaches()` on the TS side.
        var (client, handler, http) = CreateClient();
        try
        {
            // First read uses the seeded token-1.
            handler.Enqueue(HttpStatusCode.OK, """{"value":"v1"}""");
            var v1 = await client.GetValueAsync("apiUrl");
            Assert.Equal("v1", v1.GetString());
            Assert.Equal("tok-1", handler.Requests[1].Headers.Authorization!.Parameter);

            // Drop token; next call must re-exchange.
            client.InvalidateToken();
            handler.Enqueue(HttpStatusCode.OK, """{"access_token":"tok-2","expires_in":3600}""");
            handler.Enqueue(HttpStatusCode.OK, """{"value":"v2"}""");

            var v2 = await client.GetValueAsync("apiUrl");
            Assert.Equal("v2", v2.GetString());
            // Last request carried the new token.
            Assert.Equal("tok-2", handler.Requests[^1].Headers.Authorization!.Parameter);
        }
        finally
        {
            client.Dispose();
            http.Dispose();
        }
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private static (string path, string keyB64) WriteBlob(string json)
    {
        var (bundle, keyB64) = SmooConfigBuilder.Encrypt(Encoding.UTF8.GetBytes(json));
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".enc");
        File.WriteAllBytes(path, bundle);
        return (path, keyB64);
    }

    private static (SmooConfigClient client, StubHttpMessageHandler handler, HttpClient http) CreateClient()
    {
        var handler = new StubHttpMessageHandler();
        var http = new HttpClient(handler);
        // Default: seed an OAuth token exchange for the first request.
        handler.Enqueue(HttpStatusCode.OK, """{"access_token":"tok-1","expires_in":3600}""");

        var options = new SmooConfigClientOptions
        {
            ClientId = "cid",
            ClientSecret = "csec",
            OrgId = TestOrgId,
            BaseUrl = "https://api.smoo.ai",
            AuthUrl = "https://auth.smoo.ai",
            DefaultEnvironment = TestEnv,
        };
        var tokenProvider = new TokenProvider(http, options.AuthUrl!, options.ClientId, options.ClientSecret);
        var client = new SmooConfigClient(options, http, tokenProvider);
        return (client, handler, http);
    }
}
