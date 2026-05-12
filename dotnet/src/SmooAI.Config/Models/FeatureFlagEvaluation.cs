using System.Text.Json;
using System.Text.Json.Serialization;

namespace SmooAI.Config.Models;

/// <summary>
/// Wire contract for <c>POST /config/feature-flags/{key}/evaluate</c>.
/// Mirrors the TypeScript <c>EvaluateFeatureFlagResponse</c> and the schema in
/// <c>@smooai/schemas/config/feature-flag</c>. SMOODEV-959 — .NET port of the
/// segment-aware evaluator that already shipped in TS / Python / Rust / Go.
/// </summary>
public sealed class EvaluateFeatureFlagResponse
{
    /// <summary>The resolved flag value (post rules + rollout).</summary>
    [JsonPropertyName("value")]
    public JsonElement Value { get; init; }

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
/// Categorizes errors from <see cref="SmooConfigClient.EvaluateFeatureFlagAsync"/>
/// so callers can branch on 404 / 400 / 5xx without parsing the message.
/// </summary>
public enum FeatureFlagErrorKind
{
    /// <summary>5xx, network, or any non-404 / non-400 failure.</summary>
    Server,

    /// <summary>404 — the flag key is not defined in the org's schema.</summary>
    NotFound,

    /// <summary>400 — invalid context or missing environment.</summary>
    Context,
}

/// <summary>
/// Thrown by <see cref="SmooConfigClient.EvaluateFeatureFlagAsync"/> when the
/// server rejects the request or returns a non-2xx status. Use
/// <see cref="Kind"/> to branch on 404 / 400 / 5xx without parsing the
/// message. Mirrors <c>FeatureFlagEvaluationError</c> in the other SDKs.
/// </summary>
public sealed class FeatureFlagEvaluationException : Exception
{
    /// <summary>The feature-flag key the caller asked to evaluate.</summary>
    public string Key { get; }

    /// <summary>HTTP status code returned by the server.</summary>
    public int StatusCode { get; }

    /// <summary>Categorization (not-found / context / server).</summary>
    public FeatureFlagErrorKind Kind { get; }

    /// <summary>Raw response body text, if any.</summary>
    public string? ServerMessage { get; }

    public FeatureFlagEvaluationException(string key, int statusCode, FeatureFlagErrorKind kind, string? serverMessage)
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
            ? $"Feature flag \"{key}\" evaluation failed: HTTP {statusCode}"
            : $"Feature flag \"{key}\" evaluation failed: HTTP {statusCode} — {serverMessage}";
    }
}
