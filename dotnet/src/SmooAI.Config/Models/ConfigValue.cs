using System.Text.Json;
using System.Text.Json.Serialization;

namespace SmooAI.Config.Models;

/// <summary>
/// Wire envelope for <c>GET /config/values/{key}</c>.
/// </summary>
public sealed class ConfigValueResponse
{
    [JsonPropertyName("value")]
    public JsonElement Value { get; init; }
}

/// <summary>
/// Wire envelope for <c>GET /config/values</c>. The server may return a
/// legacy <c>{ values: { ... } }</c> body or a flat map; callers should
/// prefer <see cref="SmooConfigClient.GetAllValuesAsync"/> which normalizes.
/// </summary>
public sealed class ConfigValuesResponse
{
    [JsonPropertyName("values")]
    public Dictionary<string, JsonElement>? Values { get; init; }

    [JsonPropertyName("success")]
    public bool? Success { get; init; }

    [JsonPropertyName("error")]
    public string? Error { get; init; }
}
