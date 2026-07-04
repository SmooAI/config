using System.Text.Json.Serialization;

namespace SmooAI.Config.Models;

/// <summary>
/// Wire contract for <c>POST /config/limits/{key}/evaluate</c> (SMOODEV-2306).
/// The numeric sibling of <see cref="EvaluateFeatureFlagResponse"/> — same
/// segment machinery, resolved live, but <see cref="Value"/> is a number
/// (raw, pre client-side clamp).
/// </summary>
public sealed class EvaluateLimitResponse
{
    /// <summary>The raw resolved numeric value (post rules + rollout, pre clamp).</summary>
    [JsonPropertyName("value")]
    public double Value { get; init; }

    /// <summary>Id of the rule that fired, if any.</summary>
    [JsonPropertyName("matchedRuleId")]
    public string? MatchedRuleId { get; init; }

    /// <summary>0–99 bucket the context was assigned to, if a rollout ran.</summary>
    [JsonPropertyName("rolloutBucket")]
    public int? RolloutBucket { get; init; }

    /// <summary>Which branch the evaluator returned from: <c>raw</c> / <c>rule</c> / <c>rollout</c> / <c>default</c>.</summary>
    [JsonPropertyName("source")]
    public string Source { get; init; } = string.Empty;
}

/// <summary>
/// Categorizes errors from <see cref="SmooConfigClient.EvaluateLimitAsync"/>.
/// Mirrors <see cref="FeatureFlagErrorKind"/>.
/// </summary>
public enum LimitErrorKind
{
    /// <summary>5xx, network, or any non-404 / non-400 failure.</summary>
    Server,

    /// <summary>404 — the limit key is not defined in the org's schema.</summary>
    NotFound,

    /// <summary>400 — invalid context or missing environment.</summary>
    Context,
}

/// <summary>
/// Thrown by <see cref="SmooConfigClient.EvaluateLimitAsync"/> on a non-2xx
/// response. Mirrors <see cref="FeatureFlagEvaluationException"/>.
/// </summary>
public sealed class LimitEvaluationException : Exception
{
    /// <summary>The limit key the caller asked to evaluate.</summary>
    public string Key { get; }

    /// <summary>HTTP status code returned by the server.</summary>
    public int StatusCode { get; }

    /// <summary>Categorization (not-found / context / server).</summary>
    public LimitErrorKind Kind { get; }

    /// <summary>Raw response body text, if any.</summary>
    public string? ServerMessage { get; }

    public LimitEvaluationException(string key, int statusCode, LimitErrorKind kind, string? serverMessage)
        : base(BuildMessage(key, statusCode, serverMessage))
    {
        Key = key;
        StatusCode = statusCode;
        Kind = kind;
        ServerMessage = serverMessage;
    }

    private static string BuildMessage(string key, int statusCode, string? serverMessage)
    {
        return string.IsNullOrEmpty(serverMessage)
            ? $"Limit \"{key}\" evaluation failed: HTTP {statusCode}"
            : $"Limit \"{key}\" evaluation failed: HTTP {statusCode} — {serverMessage}";
    }
}

/// <summary>
/// Clamp metadata for a limit: a <see cref="Default"/> fallback plus optional
/// <see cref="Min"/> / <see cref="Max"/> / <see cref="Step"/> bounds.
/// </summary>
public readonly record struct LimitSpec(double Default, double? Min = null, double? Max = null, double? Step = null)
{
    /// <summary>
    /// Clamp a raw/resolved value into <c>[Min, Max]</c>. Non-finite input falls
    /// back to <see cref="Default"/>; <see cref="Step"/> (if set) snaps to the
    /// nearest multiple before clamping. Parity with the TS <c>clampLimit</c>.
    /// </summary>
    public double Clamp(double raw)
    {
        var n = double.IsFinite(raw) ? raw : Default;
        if (Step is { } step && step > 0)
        {
            n = Math.Round(n / step) * step;
        }
        if (Min is { } min && n < min)
        {
            n = min;
        }
        if (Max is { } max && n > max)
        {
            n = max;
        }
        return n;
    }
}
