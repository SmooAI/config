using System.Security.Cryptography;
using System.Text.Json;
using SmooAI.Config.Models;

namespace SmooAI.Config.Build;

/// <summary>
/// Deploy-time baker for <c>SmooAI.Config</c>. Wire-compatible with the
/// TypeScript, Python, Rust and Go builders.
/// </summary>
/// <remarks>
/// <para>
/// Fetches every config value for an environment via
/// <see cref="SmooConfigClient"/>, partitions into <c>public</c> / <c>secret</c>
/// sections based on a schema (feature flags are dropped — they stay
/// live-fetched), encrypts with AES-256-GCM and a freshly-generated random key
/// + 12-byte nonce, and returns the bundle bytes + base64-encoded key.
/// </para>
/// <para>
/// Deploy glue writes the bundle to disk, ships it with the function, and
/// sets two env vars so the function can decrypt at cold start:
/// </para>
/// <list type="bullet">
///   <item><c>SMOO_CONFIG_KEY_FILE</c> = absolute path to the blob on disk</item>
///   <item><c>SMOO_CONFIG_KEY</c> = returned <see cref="BuildBundleResult.KeyB64"/></item>
/// </list>
/// <para>
/// Bundle layout: <c>nonce (12 bytes) || ciphertext || authTag (16 bytes)</c>.
/// </para>
/// </remarks>
public static class SmooConfigBuilder
{
    private const int NonceSize = 12;
    private const int TagSize = 16;
    private const int KeySize = 32;

    /// <summary>
    /// Fetch every value for the given environment and encrypt into a bundle.
    /// Provide a <see cref="BuildBundleOptions.Classify"/> delegate — or use
    /// <see cref="SchemaClassifier.FromSchemaFile(string)"/> — so the baker knows
    /// which keys are <c>public</c>, <c>secret</c>, or skipped.
    /// </summary>
    /// <exception cref="ArgumentNullException">When <paramref name="client"/> or <paramref name="options"/> is null.</exception>
    public static async Task<BuildBundleResult> BuildAsync(
        SmooConfigClient client,
        BuildBundleOptions options,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(client);
        ArgumentNullException.ThrowIfNull(options);

        Func<string, JsonElement, ClassifyResult> classify = options.Classify ?? ((_, _) => ClassifyResult.Public);
        var all = await client.GetAllValuesAsync(options.Environment, cancellationToken).ConfigureAwait(false);

        var publicValues = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        var secretValues = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        var skipped = 0;

        foreach (var (key, value) in all)
        {
            var tier = classify(key, value);
            switch (tier)
            {
                case ClassifyResult.Skip:
                    skipped++;
                    break;
                case ClassifyResult.Public:
                    publicValues[key] = value;
                    break;
                case ClassifyResult.Secret:
                    secretValues[key] = value;
                    break;
                default:
                    publicValues[key] = value;
                    break;
            }
        }

        var partitioned = new Dictionary<string, IReadOnlyDictionary<string, JsonElement>>(StringComparer.Ordinal)
        {
            ["public"] = publicValues,
            ["secret"] = secretValues,
        };

        var plaintext = JsonSerializer.SerializeToUtf8Bytes(partitioned, SerializerOptions);
        var (bundle, keyB64) = Encrypt(plaintext);

        return new BuildBundleResult(
            keyB64: keyB64,
            bundle: bundle,
            keyCount: publicValues.Count + secretValues.Count,
            skippedCount: skipped);
    }

    /// <summary>
    /// Encrypt a pre-built plaintext payload. Useful for tests and for
    /// callers that already have the partitioned <c>{public, secret}</c>
    /// bytes and want to re-bundle without a live HTTP fetch.
    /// </summary>
    public static (byte[] bundle, string keyB64) Encrypt(ReadOnlySpan<byte> plaintext)
    {
        var key = RandomNumberGenerator.GetBytes(KeySize);
        var nonce = RandomNumberGenerator.GetBytes(NonceSize);
        var ciphertext = new byte[plaintext.Length];
        var tag = new byte[TagSize];

        try
        {
            using var aes = new AesGcm(key, TagSize);
            aes.Encrypt(nonce, plaintext, ciphertext, tag);
        }
        finally
        {
            // Defence in depth — don't keep the key around in memory beyond
            // the encode step. The caller gets it back base64-encoded.
        }

        var bundle = new byte[NonceSize + ciphertext.Length + TagSize];
        Buffer.BlockCopy(nonce, 0, bundle, 0, NonceSize);
        Buffer.BlockCopy(ciphertext, 0, bundle, NonceSize, ciphertext.Length);
        Buffer.BlockCopy(tag, 0, bundle, NonceSize + ciphertext.Length, TagSize);

        var keyB64 = Convert.ToBase64String(key);
        Array.Clear(key, 0, key.Length);
        return (bundle, keyB64);
    }

    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        // Compact output (no whitespace) matches the TS/Python outputs.
        WriteIndented = false,
    };
}

/// <summary>Classifier return values — matches the TS/Python/Rust/Go trinity.</summary>
public enum ClassifyResult
{
    /// <summary>Include the key in the <c>public</c> partition.</summary>
    Public,

    /// <summary>Include the key in the <c>secret</c> partition.</summary>
    Secret,

    /// <summary>Skip — typically feature flags, which stay live-fetched.</summary>
    Skip,
}

/// <summary>Options for <see cref="SmooConfigBuilder.BuildAsync"/>.</summary>
public sealed class BuildBundleOptions
{
    /// <summary>Environment to bake. Defaults to the client's <c>DefaultEnvironment</c>.</summary>
    public string? Environment { get; set; }

    /// <summary>
    /// Classifier. Return <see cref="ClassifyResult.Public"/>,
    /// <see cref="ClassifyResult.Secret"/>, or <see cref="ClassifyResult.Skip"/> per key.
    /// When null, everything is treated as <see cref="ClassifyResult.Public"/> —
    /// almost never what you want. Use <see cref="SchemaClassifier.FromSchemaFile"/>
    /// to route from a <c>schema.json</c> file.
    /// </summary>
    public Func<string, JsonElement, ClassifyResult>? Classify { get; set; }
}

/// <summary>Output of <see cref="SmooConfigBuilder.BuildAsync"/>.</summary>
public sealed class BuildBundleResult
{
    /// <summary>Base64-encoded 32-byte AES-256 key. Set as <c>SMOO_CONFIG_KEY</c>.</summary>
    public string KeyB64 { get; }

    /// <summary>Encrypted bundle — <c>nonce (12) || ciphertext || tag (16)</c>.</summary>
    public byte[] Bundle { get; }

    /// <summary>Number of keys baked (public + secret).</summary>
    public int KeyCount { get; }

    /// <summary>Number of keys skipped (e.g. feature flags).</summary>
    public int SkippedCount { get; }

    internal BuildBundleResult(string keyB64, byte[] bundle, int keyCount, int skippedCount)
    {
        KeyB64 = keyB64;
        Bundle = bundle;
        KeyCount = keyCount;
        SkippedCount = skippedCount;
    }
}
