using System.Net;
using SmooAI.Config.Container;
using SmooAI.Config.OAuth;

namespace SmooAI.Config.Tests.Container;

/// <summary>
/// Tests for container / runtime mode (SMOODEV-1491). Behavioral parity with
/// the TypeScript reference suite
/// (<c>src/container/__tests__/container.test.ts</c>): bootstrap-missing-env
/// throws and lists the missing vars; required-key-unresolved throws (not
/// absent); optional-key-absent returns null; happy-path fetch+cache;
/// 401 → refresh → retry; <c>Health</c> healthy/unhealthy.
/// </summary>
public class ContainerConfigTests
{
    private const string TestOrgId = "550e8400-e29b-41d4-a716-446655440000";
    private const string TestEnv = "production";

    // A minimal schema with one public + two secret + one flag key.
    private static ContainerConfigSchema Schema() => new(
        publicKeys: new[] { "apiBaseUrl" },
        secretKeys: new[] { "stripeApiKey", "sendgridApiKey" },
        featureFlagKeys: new[] { "newCheckout" });

    /// <summary>An env lookup that returns null for everything (clean room).</summary>
    private static Func<string, string?> EmptyEnv() => _ => null;

    /// <summary>An env lookup backed by an explicit map.</summary>
    private static Func<string, string?> EnvFrom(IDictionary<string, string?> map)
        => name => map.TryGetValue(name, out var v) ? v : null;

    private static (SmooConfigClient client, StubHttpMessageHandler handler, HttpClient http) CreateClient()
    {
        var handler = new StubHttpMessageHandler();
        var http = new HttpClient(handler);
        var options = new SmooConfigClientOptions
        {
            ClientId = "cid",
            ClientSecret = "csec",
            OrgId = TestOrgId,
            BaseUrl = "https://api.smoo.ai",
            AuthUrl = "https://auth.smoo.ai",
            DefaultEnvironment = TestEnv,
        };
        var tp = new TokenProvider(http, options.AuthUrl!, options.ClientId, options.ClientSecret);
        var client = new SmooConfigClient(options, http, tp);
        return (client, handler, http);
    }

    // -------------------------------------------------------------------------
    // Bootstrap validation (§3)
    // -------------------------------------------------------------------------

    [Fact]
    public async Task Init_throws_ConfigBootstrapException_listing_every_missing_required_var()
    {
        var err = await Assert.ThrowsAsync<ConfigBootstrapException>(() =>
            ContainerConfig.InitContainerConfigAsync(new InitContainerConfigOptions
            {
                Schema = Schema(),
                GetEnv = EmptyEnv(),
            }));

        Assert.Contains("SMOOAI_CONFIG_API_URL", err.Missing);
        Assert.Contains("SMOOAI_CONFIG_CLIENT_ID", err.Missing);
        Assert.Contains("SMOOAI_CONFIG_CLIENT_SECRET", err.Missing);
        Assert.Contains("SMOOAI_CONFIG_ORG_ID", err.Missing);
        Assert.Contains("SMOOAI_CONFIG_ENV", err.Missing);
        Assert.Contains("SMOOAI_CONFIG_API_URL", err.Message);
    }

    [Fact]
    public async Task Init_lists_only_the_actually_missing_vars()
    {
        var env = EnvFrom(new Dictionary<string, string?>
        {
            ["SMOOAI_CONFIG_API_URL"] = "https://api.smooai.test",
            ["SMOOAI_CONFIG_CLIENT_ID"] = "id",
            ["SMOOAI_CONFIG_ORG_ID"] = "org-1",
            ["SMOOAI_CONFIG_ENV"] = "production",
            // CLIENT_SECRET missing.
        });

        var err = await Assert.ThrowsAsync<ConfigBootstrapException>(() =>
            ContainerConfig.InitContainerConfigAsync(new InitContainerConfigOptions { Schema = Schema(), GetEnv = env }));

        Assert.Equal(new[] { "SMOOAI_CONFIG_CLIENT_SECRET" }, err.Missing);
    }

    [Fact]
    public async Task Init_treats_a_blank_whitespace_env_var_as_missing()
    {
        var env = EnvFrom(new Dictionary<string, string?>
        {
            ["SMOOAI_CONFIG_API_URL"] = "https://api.smooai.test",
            ["SMOOAI_CONFIG_CLIENT_ID"] = "   ",
            ["SMOOAI_CONFIG_CLIENT_SECRET"] = "secret",
            ["SMOOAI_CONFIG_ORG_ID"] = "org-1",
            ["SMOOAI_CONFIG_ENV"] = "production",
        });

        var err = await Assert.ThrowsAsync<ConfigBootstrapException>(() =>
            ContainerConfig.InitContainerConfigAsync(new InitContainerConfigOptions { Schema = Schema(), GetEnv = env }));

        Assert.Equal(new[] { "SMOOAI_CONFIG_CLIENT_ID" }, err.Missing);
    }

    [Fact]
    public async Task Init_accepts_legacy_SMOOAI_CONFIG_API_KEY_as_the_client_secret()
    {
        var env = EnvFrom(new Dictionary<string, string?>
        {
            ["SMOOAI_CONFIG_API_URL"] = "https://api.smooai.test",
            ["SMOOAI_CONFIG_CLIENT_ID"] = "id",
            ["SMOOAI_CONFIG_API_KEY"] = "legacy-secret",
            ["SMOOAI_CONFIG_ORG_ID"] = "org-1",
            ["SMOOAI_CONFIG_ENV"] = "production",
        });

        // Bootstrap should pass env validation (the legacy alias satisfies the
        // secret). The initial fetch will fail at the network layer since there
        // is no server — but the failure is NOT a bootstrap error, proving the
        // env contract was satisfied.
        var ex = await Record.ExceptionAsync(() =>
            ContainerConfig.InitContainerConfigAsync(new InitContainerConfigOptions { Schema = Schema(), GetEnv = env }));

        Assert.NotNull(ex);
        Assert.IsNotType<ConfigBootstrapException>(ex);
    }

    [Fact]
    public async Task Init_with_injected_client_only_requires_SMOOAI_CONFIG_ENV()
    {
        var (client, _, http) = CreateClient();
        try
        {
            var err = await Assert.ThrowsAsync<ConfigBootstrapException>(() =>
                ContainerConfig.InitContainerConfigAsync(new InitContainerConfigOptions
                {
                    Schema = Schema(),
                    ConfigClient = client,
                    GetEnv = EmptyEnv(),
                }));

            Assert.Equal(new[] { "SMOOAI_CONFIG_ENV" }, err.Missing);
        }
        finally { client.Dispose(); http.Dispose(); }
    }

    // -------------------------------------------------------------------------
    // Startup fetch — fail at boot, not first read (§4)
    // -------------------------------------------------------------------------

    [Fact]
    public async Task Init_throws_when_the_initial_config_fetch_fails()
    {
        var (client, handler, http) = CreateClient();
        try
        {
            // Token mint OK, then GetAllValues -> 500.
            handler.Enqueue(HttpStatusCode.OK, """{"access_token":"T","expires_in":3600}""");
            handler.Enqueue(HttpStatusCode.InternalServerError, "boom");

            var ex = await Assert.ThrowsAsync<SmooConfigApiException>(() =>
                ContainerConfig.InitContainerConfigAsync(new InitContainerConfigOptions
                {
                    Schema = Schema(),
                    Environment = TestEnv,
                    ConfigClient = client,
                }));

            Assert.Equal(500, ex.StatusCode);
        }
        finally { client.Dispose(); http.Dispose(); }
    }

    [Fact]
    public async Task HappyPath_initial_fetch_seeds_cache_and_reads_without_a_second_http_call()
    {
        var (client, handler, http) = CreateClient();
        try
        {
            handler.Enqueue(HttpStatusCode.OK, """{"access_token":"T","expires_in":3600}""");
            handler.Enqueue(HttpStatusCode.OK, """{"values":{"stripeApiKey":"sk_live_123","apiBaseUrl":"https://x"}}""");

            var handle = await ContainerConfig.InitContainerConfigAsync(new InitContainerConfigOptions
            {
                Schema = Schema(),
                Environment = TestEnv,
                ConfigClient = client,
            GetEnv = EmptyEnv(),
            });

            var callsAfterInit = handler.Requests.Count;
            Assert.Equal("sk_live_123", await handle.SecretConfig.GetAsync("stripeApiKey"));
            Assert.Equal("https://x", await handle.PublicConfig.GetAsync("apiBaseUrl"));
            // getAllValues seeded the cache, so no extra fetches.
            Assert.Equal(callsAfterInit, handler.Requests.Count);
        }
        finally { client.Dispose(); http.Dispose(); }
    }

    // -------------------------------------------------------------------------
    // Fail-loud reads (§3)
    // -------------------------------------------------------------------------

    [Fact]
    public async Task Required_secret_unresolved_throws_ConfigKeyUnresolvedException()
    {
        var (client, handler, http) = CreateClient();
        try
        {
            handler.Enqueue(HttpStatusCode.OK, """{"access_token":"T","expires_in":3600}""");
            handler.Enqueue(HttpStatusCode.OK, """{"values":{}}""");          // initial getAllValues empty
            handler.Enqueue(HttpStatusCode.OK, """{"value":null}""");          // per-key getValue absent

            var handle = await ContainerConfig.InitContainerConfigAsync(new InitContainerConfigOptions
            {
                Schema = Schema(),
                Environment = TestEnv,
                ConfigClient = client,
            GetEnv = EmptyEnv(),
            });

            var err = await Assert.ThrowsAsync<ConfigKeyUnresolvedException>(() => handle.SecretConfig.GetAsync("stripeApiKey"));
            Assert.Equal("stripeApiKey", err.Key);
            Assert.Equal(TestEnv, err.Env);
            Assert.Equal(new[] { "env", "http" }, err.TriedTiers);
        }
        finally { client.Dispose(); http.Dispose(); }
    }

    [Fact]
    public async Task Optional_key_absent_returns_null_does_not_throw()
    {
        var (client, handler, http) = CreateClient();
        try
        {
            handler.Enqueue(HttpStatusCode.OK, """{"access_token":"T","expires_in":3600}""");
            handler.Enqueue(HttpStatusCode.OK, """{"values":{}}""");
            handler.Enqueue(HttpStatusCode.OK, """{"value":null}""");

            var handle = await ContainerConfig.InitContainerConfigAsync(new InitContainerConfigOptions
            {
                Schema = Schema(),
                Environment = TestEnv,
                ConfigClient = client,
                OptionalKeys = new[] { "sendgridApiKey" },
                GetEnv = EmptyEnv(),
            });

            Assert.Null(await handle.SecretConfig.GetAsync("sendgridApiKey"));
        }
        finally { client.Dispose(); http.Dispose(); }
    }

    [Fact]
    public async Task GetSync_for_an_unresolved_required_key_throws()
    {
        var (client, handler, http) = CreateClient();
        try
        {
            handler.Enqueue(HttpStatusCode.OK, """{"access_token":"T","expires_in":3600}""");
            handler.Enqueue(HttpStatusCode.OK, """{"values":{}}""");

            var handle = await ContainerConfig.InitContainerConfigAsync(new InitContainerConfigOptions
            {
                Schema = Schema(),
                Environment = TestEnv,
                ConfigClient = client,
            GetEnv = EmptyEnv(),
            });

            Assert.Throws<ConfigKeyUnresolvedException>(() => handle.SecretConfig.GetSync("stripeApiKey"));
        }
        finally { client.Dispose(); http.Dispose(); }
    }

    [Fact]
    public async Task GetSync_returns_a_cached_value_when_present()
    {
        var (client, handler, http) = CreateClient();
        try
        {
            handler.Enqueue(HttpStatusCode.OK, """{"access_token":"T","expires_in":3600}""");
            handler.Enqueue(HttpStatusCode.OK, """{"values":{"stripeApiKey":"sk_cached"}}""");

            var handle = await ContainerConfig.InitContainerConfigAsync(new InitContainerConfigOptions
            {
                Schema = Schema(),
                Environment = TestEnv,
                ConfigClient = client,
            GetEnv = EmptyEnv(),
            });

            Assert.Equal("sk_cached", handle.SecretConfig.GetSync("stripeApiKey"));
        }
        finally { client.Dispose(); http.Dispose(); }
    }

    [Fact]
    public async Task Env_override_wins_over_http()
    {
        var (client, handler, http) = CreateClient();
        try
        {
            handler.Enqueue(HttpStatusCode.OK, """{"access_token":"T","expires_in":3600}""");
            handler.Enqueue(HttpStatusCode.OK, """{"values":{"stripeApiKey":"sk_from_http"}}""");

            var handle = await ContainerConfig.InitContainerConfigAsync(new InitContainerConfigOptions
            {
                Schema = Schema(),
                Environment = TestEnv,
                ConfigClient = client,
                GetEnv = EnvFrom(new Dictionary<string, string?> { ["STRIPE_API_KEY"] = "sk_from_env" }),
            });

            Assert.Equal("sk_from_env", await handle.SecretConfig.GetAsync("stripeApiKey"));
        }
        finally { client.Dispose(); http.Dispose(); }
    }

    [Fact]
    public async Task Reading_a_key_not_in_the_tier_throws_ArgumentException()
    {
        var (client, handler, http) = CreateClient();
        try
        {
            handler.Enqueue(HttpStatusCode.OK, """{"access_token":"T","expires_in":3600}""");
            handler.Enqueue(HttpStatusCode.OK, """{"values":{"stripeApiKey":"sk"}}""");

            var handle = await ContainerConfig.InitContainerConfigAsync(new InitContainerConfigOptions
            {
                Schema = Schema(),
                Environment = TestEnv,
                ConfigClient = client,
            GetEnv = EmptyEnv(),
            });

            // stripeApiKey is a secret, not a public key.
            await Assert.ThrowsAsync<ArgumentException>(() => handle.PublicConfig.GetAsync("stripeApiKey"));
            await Assert.ThrowsAsync<ArgumentException>(() => handle.SecretConfig.GetAsync("notDeclared"));
        }
        finally { client.Dispose(); http.Dispose(); }
    }

    // -------------------------------------------------------------------------
    // 401 -> refresh -> retry (§5)
    // -------------------------------------------------------------------------

    [Fact]
    public async Task Read_invalidates_token_and_retries_once_on_a_401()
    {
        var (client, handler, http) = CreateClient();
        try
        {
            handler.Enqueue(HttpStatusCode.OK, """{"access_token":"tok-1","expires_in":3600}""");   // initial token mint
            handler.Enqueue(HttpStatusCode.OK, """{"values":{}}""");                                   // initial getAllValues
            handler.Enqueue(HttpStatusCode.Unauthorized, "expired");                                   // per-key getValue -> 401
            handler.Enqueue(HttpStatusCode.OK, """{"access_token":"tok-2","expires_in":3600}""");      // re-mint after invalidate
            handler.Enqueue(HttpStatusCode.OK, """{"value":"sk_after_refresh"}""");                    // retry succeeds

            var handle = await ContainerConfig.InitContainerConfigAsync(new InitContainerConfigOptions
            {
                Schema = Schema(),
                Environment = TestEnv,
                ConfigClient = client,
            GetEnv = EmptyEnv(),
            });

            var v = await handle.SecretConfig.GetAsync("stripeApiKey");
            Assert.Equal("sk_after_refresh", v);
            // The 401 invalidated the cached token, forcing a re-mint; the
            // successful retry GET carried the fresh tok-2 (proves invalidate+retry).
            var lastGet = handler.Requests[^1];
            Assert.Equal("tok-2", lastGet.Headers.Authorization!.Parameter);
        }
        finally { client.Dispose(); http.Dispose(); }
    }

    // -------------------------------------------------------------------------
    // Health (§4)
    // -------------------------------------------------------------------------

    [Fact]
    public async Task Health_reports_healthy_after_a_successful_initial_fetch()
    {
        var (client, handler, http) = CreateClient();
        try
        {
            handler.Enqueue(HttpStatusCode.OK, """{"access_token":"T","expires_in":3600}""");
            handler.Enqueue(HttpStatusCode.OK, """{"values":{"stripeApiKey":"sk"}}""");

            var handle = await ContainerConfig.InitContainerConfigAsync(new InitContainerConfigOptions
            {
                Schema = Schema(),
                Environment = TestEnv,
                ConfigClient = client,
            GetEnv = EmptyEnv(),
            });

            Assert.True(handle.Health().IsHealthy);
            Assert.Equal("healthy", handle.Health().Status);
            Assert.True(ContainerConfig.Health(handle).IsHealthy);
        }
        finally { client.Dispose(); http.Dispose(); }
    }

    [Fact]
    public async Task Health_serves_healthy_within_TTL_then_unhealthy_past_hard_expiry_on_refresh_failure()
    {
        var (client, handler, http) = CreateClient();
        try
        {
            handler.Enqueue(HttpStatusCode.OK, """{"access_token":"T","expires_in":3600}""");
            handler.Enqueue(HttpStatusCode.OK, """{"values":{"stripeApiKey":"sk_initial"}}""");
            // Subsequent per-key refresh fails (503) repeatedly.
            handler.Enqueue(_ => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
            {
                Content = new StringContent("network down"),
            });
            handler.Enqueue(_ => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
            {
                Content = new StringContent("network down"),
            });

            var now = DateTimeOffset.UtcNow;
            var handle = await ContainerConfig.InitContainerConfigAsync(new InitContainerConfigOptions
            {
                Schema = Schema(),
                Environment = TestEnv,
                ConfigClient = client,
                CacheTtlMs = 30_000,
                GetEnv = EmptyEnv(),
            });
            handle.UtcNow = () => now;

            Assert.True(handle.Health().IsHealthy);

            // Advance past the per-key TTL so the cached last-good is gone AND
            // the HTTP refresh fails -> required key resolves absent.
            now = now.AddMilliseconds(31_000);
            var err = await Assert.ThrowsAsync<ConfigKeyUnresolvedException>(() => handle.SecretConfig.GetAsync("stripeApiKey"));
            Assert.Equal("stripeApiKey", err.Key);

            // Health: last refresh failed and we're past the TTL window -> unhealthy.
            var h = handle.Health();
            Assert.Equal("unhealthy", h.Status);
            Assert.Contains("network down", h.Reason ?? string.Empty);
        }
        finally { client.Dispose(); http.Dispose(); }
    }

    // -------------------------------------------------------------------------
    // SelectMode (§2)
    // -------------------------------------------------------------------------

    [Fact]
    public void SelectMode_container_when_mode_is_container()
    {
        Assert.Equal("container", ContainerConfig.SelectMode(new SelectModeInputs { Mode = "container", GetEnv = EmptyEnv() }));
        Assert.Equal("container", ContainerConfig.SelectMode(new SelectModeInputs { Mode = "CONTAINER", GetEnv = EmptyEnv() }));
    }

    [Fact]
    public void SelectMode_default_when_a_blob_or_file_source_is_present()
    {
        Assert.Equal("default", ContainerConfig.SelectMode(new SelectModeInputs
        {
            BlobPresent = true,
            ClientId = "id",
            ClientSecret = "s",
            ApiUrl = "u",
            GetEnv = EmptyEnv(),
        }));
        Assert.Equal("default", ContainerConfig.SelectMode(new SelectModeInputs
        {
            FilePresent = true,
            ClientId = "id",
            ClientSecret = "s",
            ApiUrl = "u",
            GetEnv = EmptyEnv(),
        }));
    }

    [Fact]
    public void SelectMode_auto_selects_container_on_complete_m2m_creds()
    {
        Assert.Equal("container", ContainerConfig.SelectMode(new SelectModeInputs
        {
            ClientId = "id",
            ClientSecret = "s",
            ApiUrl = "u",
            GetEnv = EmptyEnv(),
        }));
    }

    [Fact]
    public void SelectMode_falls_back_to_default_when_m2m_creds_incomplete()
    {
        Assert.Equal("default", ContainerConfig.SelectMode(new SelectModeInputs { ClientId = "id", ApiUrl = "u", GetEnv = EmptyEnv() }));
        Assert.Equal("default", ContainerConfig.SelectMode(new SelectModeInputs { GetEnv = EmptyEnv() }));
    }

    [Theory]
    [InlineData("stripeApiKey", "STRIPE_API_KEY")]
    [InlineData("apiBaseUrl", "API_BASE_URL")]
    [InlineData("newCheckout", "NEW_CHECKOUT")]
    [InlineData("url", "URL")]
    public void EnvVarNameFor_converts_camelCase_to_UPPER_SNAKE_CASE(string key, string expected)
    {
        Assert.Equal(expected, ContainerConfig.EnvVarNameFor(key));
    }

    // -------------------------------------------------------------------------
    // Typed reads + feature flags
    // -------------------------------------------------------------------------

    [Fact]
    public async Task Typed_GetAsync_deserializes_non_string_values()
    {
        var (client, handler, http) = CreateClient();
        try
        {
            handler.Enqueue(HttpStatusCode.OK, """{"access_token":"T","expires_in":3600}""");
            handler.Enqueue(HttpStatusCode.OK, """{"values":{"newCheckout":true,"apiBaseUrl":"https://x"}}""");

            var handle = await ContainerConfig.InitContainerConfigAsync(new InitContainerConfigOptions
            {
                Schema = Schema(),
                Environment = TestEnv,
                ConfigClient = client,
                GetEnv = EmptyEnv(),
            });

            Assert.True(await handle.FeatureFlag.GetAsync<bool>("newCheckout"));
            Assert.True(handle.FeatureFlag.GetSync<bool>("newCheckout"));
            Assert.Equal("https://x", await handle.PublicConfig.GetAsync<string>("apiBaseUrl"));
        }
        finally { client.Dispose(); http.Dispose(); }
    }

    // -------------------------------------------------------------------------
    // ContainerConfigSchema parsing
    // -------------------------------------------------------------------------

    [Fact]
    public void Schema_parses_defineConfig_shape()
    {
        var schema = ContainerConfigSchema.FromSchemaJson(
            """{"publicConfigSchema":{"apiBaseUrl":{}},"secretConfigSchema":{"stripeApiKey":{}},"featureFlagSchema":{"newCheckout":{}}}""");

        Assert.True(schema.ContainsInTier("apiBaseUrl", ConfigKeyTier.Public));
        Assert.True(schema.ContainsInTier("stripeApiKey", ConfigKeyTier.Secret));
        Assert.True(schema.ContainsInTier("newCheckout", ConfigKeyTier.FeatureFlag));
        Assert.False(schema.Contains("nope"));
    }

    [Fact]
    public void Schema_parses_json_schema_shape()
    {
        var schema = ContainerConfigSchema.FromSchemaJson(
            """{"properties":{"public":{"properties":{"apiBaseUrl":{}}},"secret":{"properties":{"stripeApiKey":{}}},"featureFlags":{"properties":{"newCheckout":{}}}}}""");

        Assert.True(schema.ContainsInTier("apiBaseUrl", ConfigKeyTier.Public));
        Assert.True(schema.ContainsInTier("stripeApiKey", ConfigKeyTier.Secret));
        Assert.True(schema.ContainsInTier("newCheckout", ConfigKeyTier.FeatureFlag));
    }

    [Fact]
    public void Schema_rejects_a_key_declared_in_two_tiers()
    {
        Assert.Throws<ArgumentException>(() =>
            new ContainerConfigSchema(publicKeys: new[] { "dup" }, secretKeys: new[] { "dup" }));
    }
}
