using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SmooAI.Config.Build;
using SmooAI.Config.Runtime;

namespace SmooAI.Config.Tests;

public class RuntimeTests : IDisposable
{
    public RuntimeTests()
    {
        SmooConfigRuntime.ResetForTests();
    }

    public void Dispose()
    {
        SmooConfigRuntime.ResetForTests();
    }

    [Fact]
    public void DecryptBlob_RoundTrip_ReturnsPublicAndSecret()
    {
        var payload = Encoding.UTF8.GetBytes("""{"public":{"apiUrl":"https://api.example.com"},"secret":{"dbPassword":"s3cr3t"}}""");
        var (bundle, keyB64) = SmooConfigBuilder.Encrypt(payload);

        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".enc");
        File.WriteAllBytes(path, bundle);

        try
        {
            var runtime = SmooConfigRuntime.LoadFrom(path, keyB64);
            Assert.Equal("https://api.example.com", runtime.GetPublic("apiUrl")!.Value.GetString());
            Assert.Equal("s3cr3t", runtime.GetSecret("dbPassword")!.Value.GetString());

            // GetValue prefers secret on collision semantics — verify plain lookups.
            Assert.Equal("https://api.example.com", runtime.GetValue("apiUrl")!.Value.GetString());
            Assert.Equal("s3cr3t", runtime.GetValue("dbPassword")!.Value.GetString());
            Assert.Null(runtime.GetValue("missingKey"));

            Assert.Equal(2, runtime.Baked.Count);
            Assert.False(runtime.Baked.IsEmpty);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void LoadFrom_WrongKey_Throws()
    {
        var payload = Encoding.UTF8.GetBytes("""{"public":{"apiUrl":"https://api.example.com"}}""");
        var (bundle, _) = SmooConfigBuilder.Encrypt(payload);
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".enc");
        File.WriteAllBytes(path, bundle);
        var wrongKey = Convert.ToBase64String(new byte[32]);

        try
        {
            var ex = Assert.Throws<SmooConfigRuntimeException>(() => SmooConfigRuntime.LoadFrom(path, wrongKey));
            Assert.Contains("AES-GCM", ex.Message);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void LoadFrom_TamperedBlob_Throws()
    {
        var payload = Encoding.UTF8.GetBytes("""{"public":{"apiUrl":"https://api.example.com"}}""");
        var (bundle, keyB64) = SmooConfigBuilder.Encrypt(payload);
        // Flip a byte in the ciphertext region (past the 12-byte nonce).
        bundle[20] ^= 0x01;
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".enc");
        File.WriteAllBytes(path, bundle);

        try
        {
            Assert.Throws<SmooConfigRuntimeException>(() => SmooConfigRuntime.LoadFrom(path, keyB64));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void LoadFrom_InvalidKeyLength_Throws()
    {
        var shortKey = Convert.ToBase64String(new byte[16]);
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".enc");
        File.WriteAllBytes(path, new byte[64]);

        try
        {
            var ex = Assert.Throws<SmooConfigRuntimeException>(() => SmooConfigRuntime.LoadFrom(path, shortKey));
            Assert.Contains("32 bytes", ex.Message);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void LoadFrom_BlobTooShort_Throws()
    {
        var key = Convert.ToBase64String(new byte[32]);
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".enc");
        File.WriteAllBytes(path, new byte[10]);

        try
        {
            var ex = Assert.Throws<SmooConfigRuntimeException>(() => SmooConfigRuntime.LoadFrom(path, key));
            Assert.Contains("too short", ex.Message);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void LoadFrom_InvalidBase64Key_Throws()
    {
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".enc");
        File.WriteAllBytes(path, new byte[64]);

        try
        {
            Assert.Throws<SmooConfigRuntimeException>(() => SmooConfigRuntime.LoadFrom(path, "not-valid-base64!!"));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void Load_NoEnvVars_ReturnsNull()
    {
        var prevFile = Environment.GetEnvironmentVariable(SmooConfigRuntime.KeyFileEnvVar);
        var prevKey = Environment.GetEnvironmentVariable(SmooConfigRuntime.KeyEnvVar);
        Environment.SetEnvironmentVariable(SmooConfigRuntime.KeyFileEnvVar, null);
        Environment.SetEnvironmentVariable(SmooConfigRuntime.KeyEnvVar, null);
        SmooConfigRuntime.ResetForTests();

        try
        {
            var runtime = SmooConfigRuntime.Load();
            Assert.Null(runtime);
        }
        finally
        {
            Environment.SetEnvironmentVariable(SmooConfigRuntime.KeyFileEnvVar, prevFile);
            Environment.SetEnvironmentVariable(SmooConfigRuntime.KeyEnvVar, prevKey);
        }
    }

    [Fact]
    public void Load_WithEnvVars_DecryptsAndCaches()
    {
        var payload = Encoding.UTF8.GetBytes("""{"public":{"apiUrl":"https://api.example.com"}}""");
        var (bundle, keyB64) = SmooConfigBuilder.Encrypt(payload);
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".enc");
        File.WriteAllBytes(path, bundle);

        var prevFile = Environment.GetEnvironmentVariable(SmooConfigRuntime.KeyFileEnvVar);
        var prevKey = Environment.GetEnvironmentVariable(SmooConfigRuntime.KeyEnvVar);
        Environment.SetEnvironmentVariable(SmooConfigRuntime.KeyFileEnvVar, path);
        Environment.SetEnvironmentVariable(SmooConfigRuntime.KeyEnvVar, keyB64);
        SmooConfigRuntime.ResetForTests();

        try
        {
            var r1 = SmooConfigRuntime.Load();
            Assert.NotNull(r1);
            Assert.Equal("https://api.example.com", r1!.GetPublic("apiUrl")!.Value.GetString());

            // Cached — second call returns the same instance.
            var r2 = SmooConfigRuntime.Load();
            Assert.Same(r1, r2);
        }
        finally
        {
            Environment.SetEnvironmentVariable(SmooConfigRuntime.KeyFileEnvVar, prevFile);
            Environment.SetEnvironmentVariable(SmooConfigRuntime.KeyEnvVar, prevKey);
            File.Delete(path);
            SmooConfigRuntime.ResetForTests();
        }
    }

    [Fact]
    public void GetValue_Generic_Deserializes()
    {
        var payload = Encoding.UTF8.GetBytes("""{"public":{"retries":3,"enabled":true,"apiUrl":"https://api.example.com"}}""");
        var (bundle, keyB64) = SmooConfigBuilder.Encrypt(payload);
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".enc");
        File.WriteAllBytes(path, bundle);

        try
        {
            var runtime = SmooConfigRuntime.LoadFrom(path, keyB64);
            Assert.Equal(3, runtime.GetValue<int>("retries"));
            Assert.True(runtime.GetValue<bool>("enabled"));
            Assert.Equal("https://api.example.com", runtime.GetValue<string>("apiUrl"));
            Assert.Null(runtime.GetValue<string>("missing"));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void WireCompat_DecryptsBlobBuiltByThisImpl()
    {
        // Layout: 12-byte nonce || ciphertext || 16-byte tag — what every
        // other language emits. Rebuild it here byte-by-byte and check we
        // decode it back to the same JSON.
        var key = RandomNumberGenerator.GetBytes(32);
        var nonce = RandomNumberGenerator.GetBytes(12);
        var plaintext = Encoding.UTF8.GetBytes("""{"public":{"k":"v"},"secret":{}}""");
        var ciphertext = new byte[plaintext.Length];
        var tag = new byte[16];
        using (var aes = new AesGcm(key, 16))
        {
            aes.Encrypt(nonce, plaintext, ciphertext, tag);
        }
        var bundle = new byte[nonce.Length + ciphertext.Length + tag.Length];
        Buffer.BlockCopy(nonce, 0, bundle, 0, nonce.Length);
        Buffer.BlockCopy(ciphertext, 0, bundle, nonce.Length, ciphertext.Length);
        Buffer.BlockCopy(tag, 0, bundle, nonce.Length + ciphertext.Length, tag.Length);

        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".enc");
        File.WriteAllBytes(path, bundle);

        try
        {
            var runtime = SmooConfigRuntime.LoadFrom(path, Convert.ToBase64String(key));
            Assert.Equal("v", runtime.GetPublic("k")!.Value.GetString());
        }
        finally
        {
            File.Delete(path);
        }
    }
}
