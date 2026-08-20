using System.Text.Json;
using SmooAI.Config.Local;
using SmooAI.Config.Typed;

namespace SmooAI.Config.Tests;

// Shares the process-global SMOOAI_CONFIG_FILE_DIR and EnvFileFallback's static
// file cache with ResolveAsyncFallbackTests, so it must not run beside it.
[Collection("EnvSerial")]
public class LocalConfigManagerTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), $"smooai-local-{Guid.NewGuid():N}");
    private readonly string? _previousFileDir = Environment.GetEnvironmentVariable(EnvFileFallback.FileDirEnvVar);

    public LocalConfigManagerTests()
    {
        Directory.CreateDirectory(_dir);
        Environment.SetEnvironmentVariable(EnvFileFallback.FileDirEnvVar, _dir);
        EnvFileFallback.ResetFileCacheForTests();
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable(EnvFileFallback.FileDirEnvVar, _previousFileDir);
        EnvFileFallback.ResetFileCacheForTests();
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
        GC.SuppressFinalize(this);
    }

    private void WriteFileConfig(string environment, string json)
        => File.WriteAllText(Path.Combine(_dir, $"{environment}.json"), json);

    private static LocalConfigManager Manager(string environment = "development", IReadOnlyDictionary<string, string?>? env = null, TimeSpan? ttl = null)
        => new(new LocalConfigOptions { Environment = environment, EnvOverride = env, CacheTtl = ttl ?? TimeSpan.FromHours(24) });

    [Fact]
    public void ReadsFromTheFileTier()
    {
        WriteFileConfig("development", """{"apiUrl":"https://from-file.example"}""");

        Assert.Equal("https://from-file.example", Manager().GetPublicConfig("apiUrl")?.GetString());
    }

    [Fact]
    public void FallsBackToTheEnvTier()
    {
        var env = new Dictionary<string, string?>(StringComparer.Ordinal) { ["SMOOAI_CONFIG_API_URL"] = "https://from-env.example" };

        Assert.Equal("https://from-env.example", Manager(env: env).GetPublicConfig("apiUrl")?.GetString());
    }

    [Fact]
    public void FileTierWinsOverEnvTier()
    {
        WriteFileConfig("development", """{"apiUrl":"https://from-file.example"}""");
        var env = new Dictionary<string, string?>(StringComparer.Ordinal) { ["SMOOAI_CONFIG_API_URL"] = "https://from-env.example" };

        Assert.Equal("https://from-file.example", Manager(env: env).GetPublicConfig("apiUrl")?.GetString());
    }

    [Fact]
    public void ReturnsNullWhenNoTierHasTheKey()
    {
        Assert.Null(Manager().GetPublicConfig("missingKey"));
    }

    [Fact]
    public void EnvTierParsesJsonShapedValues()
    {
        var env = new Dictionary<string, string?>(StringComparer.Ordinal)
        {
            ["SMOOAI_CONFIG_MAX_RETRIES"] = "5",
            ["SMOOAI_CONFIG_ENABLED"] = "true",
            ["SMOOAI_CONFIG_PLAIN"] = "not json",
        };
        var manager = Manager(env: env);

        Assert.Equal(5, manager.GetPublicConfig("maxRetries")?.GetInt32());
        Assert.True(manager.GetPublicConfig("enabled")?.GetBoolean());
        Assert.Equal("not json", manager.GetPublicConfig("plain")?.GetString());
    }

    [Fact]
    public void ReadsThePerEnvironmentFile()
    {
        WriteFileConfig("development", """{"apiUrl":"https://dev.example"}""");
        WriteFileConfig("production", """{"apiUrl":"https://prod.example"}""");

        Assert.Equal("https://dev.example", Manager("development").GetPublicConfig("apiUrl")?.GetString());
        Assert.Equal("https://prod.example", Manager("production").GetPublicConfig("apiUrl")?.GetString());
    }

    [Fact]
    public void TiersAreCachedPerTierSoAKeyCanDifferBetweenThem()
    {
        WriteFileConfig("development", """{"shared":"value"}""");
        var manager = Manager();

        Assert.Equal("value", manager.GetPublicConfig("shared")?.GetString());
        Assert.Equal("value", manager.GetSecretConfig("shared")?.GetString());
        Assert.Equal("value", manager.GetFeatureFlag("shared")?.GetString());
    }

    [Fact]
    public void CachesSoALaterFileEditIsNotSeenUntilInvalidate()
    {
        WriteFileConfig("development", """{"apiUrl":"https://first.example"}""");
        var manager = Manager();
        Assert.Equal("https://first.example", manager.GetPublicConfig("apiUrl")?.GetString());

        WriteFileConfig("development", """{"apiUrl":"https://second.example"}""");
        Assert.Equal("https://first.example", manager.GetPublicConfig("apiUrl")?.GetString());

        manager.Invalidate();
        Assert.Equal("https://second.example", manager.GetPublicConfig("apiUrl")?.GetString());
    }

    [Fact]
    public void AnExpiredEntryIsRefetched()
    {
        WriteFileConfig("development", """{"apiUrl":"https://first.example"}""");
        var manager = Manager(ttl: TimeSpan.Zero);
        Assert.Equal("https://first.example", manager.GetPublicConfig("apiUrl")?.GetString());

        EnvFileFallback.ResetFileCacheForTests();
        WriteFileConfig("development", """{"apiUrl":"https://second.example"}""");

        Assert.Equal("https://second.example", manager.GetPublicConfig("apiUrl")?.GetString());
    }

    [Fact]
    public void AMalformedFileFallsThroughRatherThanThrowing()
    {
        WriteFileConfig("development", "{ not json");
        var env = new Dictionary<string, string?>(StringComparer.Ordinal) { ["SMOOAI_CONFIG_API_URL"] = "https://from-env.example" };

        Assert.Equal("https://from-env.example", Manager(env: env).GetPublicConfig("apiUrl")?.GetString());
    }

    // SMOODEV-847 — an empty key means a typed-keys constant was read for a key
    // that is not in the schema. Say so loudly instead of returning null.
    [Fact]
    public void EmptyKeyThrowsWithAnActionableMessage()
    {
        var error = Assert.Throws<ArgumentException>(() => Manager().GetPublicConfig(""));
        Assert.Contains("not declared in your schema", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ConcurrentReadsAreSafe()
    {
        WriteFileConfig("development", """{"apiUrl":"https://from-file.example"}""");
        var manager = Manager();

        var results = new JsonElement?[64];
        Parallel.For(0, results.Length, i => results[i] = manager.GetPublicConfig("apiUrl"));

        Assert.All(results, result => Assert.Equal("https://from-file.example", result?.GetString()));
    }
}
