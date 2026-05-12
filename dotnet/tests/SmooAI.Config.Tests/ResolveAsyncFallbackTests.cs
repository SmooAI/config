using System.Net;
using System.Text.Json;
using SmooAI.Config.Models;
using SmooAI.Config.OAuth;
using SmooAI.Config.Runtime;
using SmooAI.Config.Typed;

namespace SmooAI.Config.Tests;

/// <summary>
/// SMOODEV-957 — verifies the bake → env → HTTP → file priority chain in
/// <see cref="ConfigKey{T}.ResolveAsync"/>. Mirrors the priority-chain
/// integration tests in the other SDKs (Go: <c>priority_chain_integration_test.go</c>;
/// Python: <c>test_priority_chain_integration.py</c>; Rust:
/// <c>priority_chain_integration.rs</c>).
/// </summary>
[Collection("EnvSerial")]
public class ResolveAsyncFallbackTests : IDisposable
{
    private readonly string _tempDir;
    private readonly List<string> _envVarsToReset = new();
    private readonly Dictionary<string, string?> _originalEnv = new();

    public ResolveAsyncFallbackTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), $"smooai-config-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_tempDir);
        EnvFileFallback.ResetFileCacheForTests();
    }

    public void Dispose()
    {
        // Restore env vars
        foreach (var (name, original) in _originalEnv)
        {
            Environment.SetEnvironmentVariable(name, original);
        }
        EnvFileFallback.ResetFileCacheForTests();
        try { Directory.Delete(_tempDir, recursive: true); } catch { /* best-effort */ }
    }

    private void SetEnv(string name, string? value)
    {
        if (!_originalEnv.ContainsKey(name))
        {
            _originalEnv[name] = Environment.GetEnvironmentVariable(name);
        }
        Environment.SetEnvironmentVariable(name, value);
    }

    private static SmooConfigClientOptions Options() => new()
    {
        ClientId = "cid",
        ClientSecret = "csec",
        OrgId = "org-uuid",
        BaseUrl = "https://api.smoo.ai",
        AuthUrl = "https://auth.smoo.ai",
        DefaultEnvironment = "production",
    };

    private static (SmooConfigClient client, StubHttpMessageHandler handler) CreateClient(bool seedToken = true)
    {
        var handler = new StubHttpMessageHandler();
        var http = new HttpClient(handler);
        if (seedToken)
        {
            handler.Enqueue(HttpStatusCode.OK, """{"access_token":"tok-1","expires_in":3600}""");
        }
        var options = Options();
        var tokenProvider = new TokenProvider(http, options.AuthUrl!, options.ClientId, options.ClientSecret);
        var client = new SmooConfigClient(options, http, tokenProvider);
        return (client, handler);
    }

    private void WriteFileDefault(string environment, object payload)
    {
        SetEnv(EnvFileFallback.FileDirEnvVar, _tempDir);
        var path = Path.Combine(_tempDir, $"{environment}.json");
        File.WriteAllText(path, JsonSerializer.Serialize(payload));
        EnvFileFallback.ResetFileCacheForTests();
    }

    // --- 1. Env-var fallback ---

    [Fact]
    public async Task EnvVar_overrides_http_when_runtime_absent()
    {
        var (client, handler) = CreateClient();
        // HTTP would return "from-http" but env-var beats it.
        handler.Enqueue(HttpStatusCode.OK, """{"value":"from-http"}""");

        SetEnv("SMOOAI_CONFIG_MOONSHOT_API_KEY", "from-env");

        var key = new ConfigKey<string>("moonshotApiKey", ConfigTier.Secret);
        var value = await key.ResolveAsync(runtime: null, client);

        Assert.Equal("from-env", value);
        // The env-var tier short-circuits before the HTTP client is touched,
        // so no requests (not even the token exchange) should fire.
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task EnvVar_camelCase_key_maps_to_upper_snake_var()
    {
        var (client, _) = CreateClient(seedToken: false);
        SetEnv("SMOOAI_CONFIG_API_URL", "\"https://override.example\"");

        var key = new ConfigKey<string>("apiUrl", ConfigTier.Public);
        var value = await key.ResolveAsync(null, client);

        Assert.Equal("https://override.example", value);
    }

    [Fact]
    public async Task EnvVar_parses_json_payload_for_typed_round_trip()
    {
        var (client, _) = CreateClient(seedToken: false);
        SetEnv("SMOOAI_CONFIG_MAX_RETRIES", "7");

        var key = new ConfigKey<int>("maxRetries", ConfigTier.Public);
        var value = await key.ResolveAsync(null, client);

        Assert.Equal(7, value);
    }

    // --- 2. File-tier fallback ---

    [Fact]
    public async Task File_used_when_http_fails()
    {
        var (client, handler) = CreateClient();
        // HTTP returns 500 → ResolveAsync should fall through to the file.
        handler.Enqueue(HttpStatusCode.InternalServerError, "boom");

        WriteFileDefault("production", new { moonshotApiKey = "from-file" });

        var key = new ConfigKey<string>("moonshotApiKey", ConfigTier.Secret);
        var value = await key.ResolveAsync(null, client);

        Assert.Equal("from-file", value);
    }

    [Fact]
    public async Task File_used_when_http_returns_missing()
    {
        var (client, handler) = CreateClient();
        // HTTP returns an empty value envelope (key not in remote schema).
        handler.Enqueue(HttpStatusCode.OK, """{"value":null}""");

        WriteFileDefault("production", new { localOnlyKey = "from-file" });

        var key = new ConfigKey<string>("localOnlyKey", ConfigTier.Public);
        var value = await key.ResolveAsync(null, client);

        Assert.Equal("from-file", value);
    }

    [Fact]
    public async Task File_honors_environment_override()
    {
        var (client, handler) = CreateClient();
        handler.Enqueue(HttpStatusCode.OK, """{"value":null}""");

        WriteFileDefault("staging", new { stageKey = "staging-value" });

        var key = new ConfigKey<string>("stageKey", ConfigTier.Public);
        var value = await key.ResolveAsync(null, client, environment: "staging");

        Assert.Equal("staging-value", value);
    }

    [Fact]
    public async Task File_defaults_to_development_when_environment_unspecified()
    {
        // Override client default environment to something the file doesn't
        // exist for, to force the dev path. Easier: rebuild with default env.
        var handler = new StubHttpMessageHandler();
        var http = new HttpClient(handler);
        handler.Enqueue(HttpStatusCode.OK, """{"access_token":"tok-1","expires_in":3600}""");
        var options = new SmooConfigClientOptions
        {
            ClientId = "cid",
            ClientSecret = "csec",
            OrgId = "org-uuid",
            BaseUrl = "https://api.smoo.ai",
            AuthUrl = "https://auth.smoo.ai",
            DefaultEnvironment = "development",
        };
        var tokenProvider = new TokenProvider(http, options.AuthUrl!, options.ClientId, options.ClientSecret);
        var client = new SmooConfigClient(options, http, tokenProvider);

        handler.Enqueue(HttpStatusCode.OK, """{"value":null}""");

        WriteFileDefault("development", new { localKey = "dev-default" });

        var key = new ConfigKey<string>("localKey", ConfigTier.Public);
        var value = await key.ResolveAsync(null, client);

        Assert.Equal("dev-default", value);
    }

    // --- 3. Bake still wins ---

    [Fact]
    public async Task Bake_wins_over_env_and_file()
    {
        var (client, _) = CreateClient(seedToken: false);

        // Both env + file would resolve to other values — bake must beat them.
        SetEnv("SMOOAI_CONFIG_MOONSHOT_API_KEY", "from-env");
        WriteFileDefault("production", new { moonshotApiKey = "from-file" });

        // Build a synthetic baked runtime.
        var baked = new BakedConfig(
            publicValues: new Dictionary<string, JsonElement>(),
            secretValues: new Dictionary<string, JsonElement>
            {
                ["moonshotApiKey"] = JsonSerializer.SerializeToElement("from-bake"),
            });
        var runtime = SmooConfigRuntimeTestAccess.NewFromBaked(baked);

        var key = new ConfigKey<string>("moonshotApiKey", ConfigTier.Secret);
        var value = await key.ResolveAsync(runtime, client);

        Assert.Equal("from-bake", value);
    }

    [Fact]
    public async Task Env_wins_over_http_and_file()
    {
        var (client, handler) = CreateClient();
        handler.Enqueue(HttpStatusCode.OK, """{"value":"from-http"}""");
        SetEnv("SMOOAI_CONFIG_MOONSHOT_API_KEY", "from-env");
        WriteFileDefault("production", new { moonshotApiKey = "from-file" });

        var key = new ConfigKey<string>("moonshotApiKey", ConfigTier.Secret);
        var value = await key.ResolveAsync(null, client);

        Assert.Equal("from-env", value);
    }

    [Fact]
    public async Task Http_wins_over_file_when_present()
    {
        var (client, handler) = CreateClient();
        handler.Enqueue(HttpStatusCode.OK, """{"value":"from-http"}""");
        WriteFileDefault("production", new { moonshotApiKey = "from-file" });

        var key = new ConfigKey<string>("moonshotApiKey", ConfigTier.Secret);
        var value = await key.ResolveAsync(null, client);

        Assert.Equal("from-http", value);
    }

    [Fact]
    public async Task Missing_everywhere_returns_default()
    {
        var (client, handler) = CreateClient();
        handler.Enqueue(HttpStatusCode.OK, """{"value":null}""");
        // No env var, no file written (FileDirEnvVar unset → default dir,
        // which the test fixture doesn't populate).

        var key = new ConfigKey<string>("nonExistent", ConfigTier.Public);
        var value = await key.ResolveAsync(null, client);

        Assert.Null(value);
    }
}

/// <summary>
/// Backdoor for building a <see cref="SmooConfigRuntime"/> from an in-memory
/// <see cref="BakedConfig"/> — the public API only loads from an encrypted
/// blob on disk.
/// </summary>
internal static class SmooConfigRuntimeTestAccess
{
    public static SmooConfigRuntime NewFromBaked(BakedConfig baked)
    {
        // Use reflection to call the private ctor; this lives in the same
        // assembly thanks to InternalsVisibleTo (test project).
        var ctor = typeof(SmooConfigRuntime).GetConstructor(
            System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic,
            binder: null,
            types: new[] { typeof(BakedConfig) },
            modifiers: null);
        if (ctor is null) throw new InvalidOperationException("SmooConfigRuntime private ctor not found");
        return (SmooConfigRuntime)ctor.Invoke(new object[] { baked });
    }
}
