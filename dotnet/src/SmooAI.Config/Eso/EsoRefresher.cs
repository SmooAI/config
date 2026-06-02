using System;
using System.Threading;
using System.Threading.Tasks;

namespace SmooAI.Config.Eso;

// ESO bearer-token refresher core — C# parity port of the TypeScript
// src/eso-refresher (SMOODEV-1526, epic SMOODEV-1522).
//
// ESO's webhook provider reads a STATIC bearer from a k8s Secret, but the config
// API issues short-lived client_credentials JWTs (~1h) — so a static token goes
// stale and ESO sync silently 401s. This refresher re-mints the token on a short
// interval via the same TokenProvider the SDK uses and writes it into the
// bootstrap Secret, so ESO always reads a fresh bearer.
//
// The k8s write is abstracted behind ISecretWriter so the loop is unit-testable
// with a fake (no live cluster). A native KubernetesClient-backed writer is an
// optional adapter (kept out of this core so base SDK consumers do not pull a
// heavy k8s client) — the TypeScript sidecar remains the canonical deployable;
// this gives the refresh ALGORITHM parity in C#.

/// <summary>Writes the freshly-minted bearer token into the target Secret.</summary>
public interface ISecretWriter
{
    Task PatchBearerTokenAsync(string token, CancellationToken cancellationToken = default);
}

/// <summary>The slice of TokenProvider the refresher needs. The real
/// <c>TokenProvider</c> satisfies it; tests inject a fake.</summary>
public interface ITokenSource
{
    Task<string> GetAccessTokenAsync(CancellationToken cancellationToken = default);
    void Invalidate();
}

/// <summary>Drives the ESO bearer refresh: re-mints a fresh token and writes it
/// to the target Secret on each cycle.</summary>
public sealed class EsoRefresher
{
    public const int DefaultIntervalSeconds = 900;

    private readonly ITokenSource _tokenSource;
    private readonly ISecretWriter _secretWriter;

    /// <summary>The configured re-mint interval.</summary>
    public TimeSpan Interval { get; }

    public EsoRefresher(ITokenSource tokenSource, ISecretWriter secretWriter, TimeSpan interval = default)
    {
        _tokenSource = tokenSource ?? throw new ArgumentException("EsoRefresher: tokenSource is required", nameof(tokenSource));
        _secretWriter = secretWriter ?? throw new ArgumentException("EsoRefresher: secretWriter is required", nameof(secretWriter));
        Interval = interval <= TimeSpan.Zero ? TimeSpan.FromSeconds(DefaultIntervalSeconds) : interval;
    }

    /// <summary>
    /// Force a brand-new token mint + write. Invalidates first so the Secret
    /// always holds a token with (close to) a full TTL ahead — ESO must never
    /// read a token about to expire.
    /// </summary>
    public async Task RefreshOnceAsync(CancellationToken cancellationToken = default)
    {
        _tokenSource.Invalidate();
        var token = await _tokenSource.GetAccessTokenAsync(cancellationToken).ConfigureAwait(false);
        await _secretWriter.PatchBearerTokenAsync(token, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Run the refresher: an initial fail-loud mint+write, then loop on the
    /// interval until cancellation. Loop failures are swallowed (the current
    /// Secret token is still valid for the rest of its TTL) and retried next tick.
    /// </summary>
    public async Task RunAsync(CancellationToken cancellationToken)
    {
        // Initial mint+write — fail-loud (exceptions propagate out of RunAsync).
        await RefreshOnceAsync(cancellationToken).ConfigureAwait(false);

        using var timer = new PeriodicTimer(Interval);
        while (await timer.WaitForNextTickAsync(cancellationToken).ConfigureAwait(false))
        {
            try
            {
                await RefreshOnceAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch
            {
                // Non-fatal: retry on the next tick.
            }
        }
    }
}
