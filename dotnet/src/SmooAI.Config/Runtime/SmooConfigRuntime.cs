using System.Security.Cryptography;
using System.Text.Json;

namespace SmooAI.Config.Runtime;

/// <summary>
/// Bake-aware local runtime for <c>SmooAI.Config</c>. Parity with the
/// TypeScript, Python, Rust and Go implementations.
/// </summary>
/// <remarks>
/// <para>
/// Reads a pre-encrypted blob produced by the <c>@smooai/config</c> build
/// pipeline (or any of its language ports) and exposes sync accessors to the
/// decrypted <c>{public, secret}</c> values — no network call after the cold
/// start.
/// </para>
/// <para>
/// Environment variables:
/// <list type="bullet">
///   <item><c>SMOO_CONFIG_KEY_FILE</c> — absolute path to the encrypted blob on disk.</item>
///   <item><c>SMOO_CONFIG_KEY</c> — base64-encoded 32-byte AES-256 key.</item>
/// </list>
/// </para>
/// <para>
/// Blob layout (wire-compatible with every other language): <c>nonce (12 bytes) || ciphertext || authTag (16 bytes)</c>.
/// </para>
/// <para>
/// Feature flags are never baked — they stay live-fetched via
/// <see cref="SmooConfigClient"/>. The runtime only surfaces public + secret
/// values from the blob.
/// </para>
/// </remarks>
public sealed class SmooConfigRuntime
{
    /// <summary>Environment variable name for the blob file path.</summary>
    public const string KeyFileEnvVar = "SMOO_CONFIG_KEY_FILE";

    /// <summary>Environment variable name for the base64 AES key.</summary>
    public const string KeyEnvVar = "SMOO_CONFIG_KEY";

    private const int NonceSize = 12;
    private const int TagSize = 16;
    private const int KeySize = 32;

    private static readonly object s_lock = new();
    private static SmooConfigRuntime? s_cached;
    private static bool s_cachedLoaded;

    /// <summary>Decrypted baked config. Never null.</summary>
    public BakedConfig Baked { get; }

    private SmooConfigRuntime(BakedConfig baked)
    {
        Baked = baked;
    }

    /// <summary>
    /// Load the runtime from environment variables. Returns <c>null</c> when
    /// <see cref="KeyFileEnvVar"/> or <see cref="KeyEnvVar"/> is not set — the
    /// caller should fall back to a live client on dev machines without a
    /// baked blob.
    /// </summary>
    /// <remarks>
    /// Subsequent calls return the cached singleton — decryption only happens
    /// once per process. Thread-safe.
    /// </remarks>
    /// <exception cref="SmooConfigRuntimeException">
    /// When the key or blob is present but malformed / tampered with. Missing
    /// env vars return <c>null</c> (not throw).
    /// </exception>
    public static SmooConfigRuntime? Load()
    {
        if (s_cachedLoaded) return s_cached;

        lock (s_lock)
        {
            if (s_cachedLoaded) return s_cached;

            var keyFile = Environment.GetEnvironmentVariable(KeyFileEnvVar);
            var keyB64 = Environment.GetEnvironmentVariable(KeyEnvVar);
            if (string.IsNullOrEmpty(keyFile) || string.IsNullOrEmpty(keyB64))
            {
                s_cached = null;
                s_cachedLoaded = true;
                return null;
            }

            var baked = DecryptBlob(keyFile, keyB64);
            s_cached = new SmooConfigRuntime(baked);
            s_cachedLoaded = true;
            return s_cached;
        }
    }

    /// <summary>
    /// Load from explicit file path + base64 key, bypassing env vars. Useful
    /// for tests and one-off tooling; bypasses the process-wide cache.
    /// </summary>
    /// <param name="keyFile">Path to the <c>.enc</c> blob.</param>
    /// <param name="keyB64">Base64 AES-256 key.</param>
    public static SmooConfigRuntime LoadFrom(string keyFile, string keyB64)
    {
        if (string.IsNullOrWhiteSpace(keyFile)) throw new ArgumentException("Key file path is required.", nameof(keyFile));
        if (string.IsNullOrWhiteSpace(keyB64)) throw new ArgumentException("Key (base64) is required.", nameof(keyB64));

        return new SmooConfigRuntime(DecryptBlob(keyFile, keyB64));
    }

    /// <summary>
    /// Reset the process-wide cache. Test-only — never call in production.
    /// </summary>
    internal static void ResetForTests()
    {
        lock (s_lock)
        {
            s_cached = null;
            s_cachedLoaded = false;
        }
    }

    /// <summary>
    /// Get a value by key, checking the public partition first then falling
    /// back to the secret partition (matches the TS/Python/Rust/Go merge
    /// order). Returns <c>null</c> when the key is absent.
    /// </summary>
    public JsonElement? GetValue(string key)
    {
        if (string.IsNullOrWhiteSpace(key)) throw new ArgumentException("Key is required.", nameof(key));

        if (Baked.Secret.TryGetValue(key, out var secret)) return secret;
        if (Baked.Public.TryGetValue(key, out var pub)) return pub;
        return null;
    }

    /// <summary>
    /// Get a public config value. Returns <c>null</c> when the key is not
    /// present in the public partition.
    /// </summary>
    public JsonElement? GetPublic(string key)
    {
        if (string.IsNullOrWhiteSpace(key)) throw new ArgumentException("Key is required.", nameof(key));
        return Baked.Public.TryGetValue(key, out var v) ? v : null;
    }

    /// <summary>
    /// Get a secret config value. Returns <c>null</c> when the key is not
    /// present in the secret partition.
    /// </summary>
    public JsonElement? GetSecret(string key)
    {
        if (string.IsNullOrWhiteSpace(key)) throw new ArgumentException("Key is required.", nameof(key));
        return Baked.Secret.TryGetValue(key, out var v) ? v : null;
    }

    /// <summary>
    /// Typed accessor — deserializes the value via <c>JsonElement.Deserialize&lt;T&gt;()</c>.
    /// </summary>
    public T? GetValue<T>(string key)
    {
        var el = GetValue(key);
        if (el is null) return default;
        return el.Value.Deserialize<T>(SmooConfigClient.JsonOptions);
    }

    /// <summary>
    /// Decrypt a blob given an explicit path + base64 key. Exposed for
    /// tests; most callers should use <see cref="Load"/>.
    /// </summary>
    internal static BakedConfig DecryptBlob(string keyFile, string keyB64)
    {
        byte[] key;
        try
        {
            key = Convert.FromBase64String(keyB64);
        }
        catch (FormatException ex)
        {
            throw new SmooConfigRuntimeException($"{KeyEnvVar} is not valid base64: {ex.Message}", ex);
        }

        if (key.Length != KeySize)
        {
            throw new SmooConfigRuntimeException($"{KeyEnvVar} must decode to {KeySize} bytes (got {key.Length}).");
        }

        byte[] blob;
        try
        {
            blob = File.ReadAllBytes(keyFile);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or DirectoryNotFoundException or FileNotFoundException)
        {
            throw new SmooConfigRuntimeException($"Failed to read config blob at {keyFile}: {ex.Message}", ex);
        }

        if (blob.Length < NonceSize + TagSize)
        {
            throw new SmooConfigRuntimeException($"smoo-config blob too short ({blob.Length} bytes, expected at least {NonceSize + TagSize}).");
        }

        var nonce = blob.AsSpan(0, NonceSize);
        var tag = blob.AsSpan(blob.Length - TagSize, TagSize);
        var ciphertext = blob.AsSpan(NonceSize, blob.Length - NonceSize - TagSize);
        var plaintext = new byte[ciphertext.Length];

        try
        {
            using var aes = new AesGcm(key, TagSize);
            aes.Decrypt(nonce, ciphertext, tag, plaintext);
        }
        catch (CryptographicException ex)
        {
            throw new SmooConfigRuntimeException("AES-GCM decryption failed (wrong key or tampered blob).", ex);
        }
        finally
        {
            // Zero the key — we're done with it.
            Array.Clear(key, 0, key.Length);
        }

        try
        {
            using var doc = JsonDocument.Parse(plaintext);
            var root = doc.RootElement;

            var pub = ReadPartition(root, "public");
            var sec = ReadPartition(root, "secret");
            return new BakedConfig(pub, sec);
        }
        catch (JsonException ex)
        {
            throw new SmooConfigRuntimeException($"Failed to parse decrypted config JSON: {ex.Message}", ex);
        }
    }

    private static IReadOnlyDictionary<string, JsonElement> ReadPartition(JsonElement root, string name)
    {
        if (root.ValueKind != JsonValueKind.Object) return Empty;
        if (!root.TryGetProperty(name, out var section) || section.ValueKind != JsonValueKind.Object)
        {
            return Empty;
        }

        var dict = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var prop in section.EnumerateObject())
        {
            // .Clone() so the value survives the JsonDocument Dispose().
            dict[prop.Name] = prop.Value.Clone();
        }
        return dict;
    }

    private static readonly IReadOnlyDictionary<string, JsonElement> Empty = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
}

/// <summary>Thrown when the runtime fails to load or decrypt a baked blob.</summary>
public sealed class SmooConfigRuntimeException : Exception
{
    public SmooConfigRuntimeException(string message) : base(message) { }
    public SmooConfigRuntimeException(string message, Exception inner) : base(message, inner) { }
}
