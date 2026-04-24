using SmooAI.Config.SourceGenerator;

namespace SmooAI.Config.SourceGenerator.Tests;

public class SchemaParsingTests
{
    [Fact]
    public void Parse_JsonSchemaShape_ExtractsAllThreeTiers()
    {
        var json = """
            {
              "$schema": "http://json-schema.org/draft-07/schema#",
              "type": "object",
              "properties": {
                "public":       { "type": "object", "properties": { "apiUrl":     { "type": "string"  } } },
                "secret":       { "type": "object", "properties": { "dbPassword": { "type": "string"  } } },
                "featureFlags": { "type": "object", "properties": { "newFlow":    { "type": "boolean" } } }
              }
            }
            """;
        var parsed = SmooConfigSchemaGenerator.Parse(json);
        Assert.Collection(parsed.PublicKeys, k => { Assert.Equal("apiUrl", k.Name); Assert.Equal("string", k.ClrType); });
        Assert.Collection(parsed.SecretKeys, k => { Assert.Equal("dbPassword", k.Name); Assert.Equal("string", k.ClrType); });
        Assert.Collection(parsed.FeatureFlagKeys, k => { Assert.Equal("newFlow", k.Name); Assert.Equal("bool", k.ClrType); });
    }

    [Fact]
    public void Parse_SerializedDefineConfigShape_MapsStringBooleanNumber()
    {
        var json = """
            {
              "publicConfigSchema": {
                "apiUrl":  "stringSchema",
                "retries": "numberSchema"
              },
              "secretConfigSchema": {
                "dbPassword": "stringSchema"
              },
              "featureFlagSchema": {
                "newFlow": "booleanSchema"
              }
            }
            """;
        var parsed = SmooConfigSchemaGenerator.Parse(json);

        var pub = parsed.PublicKeys.ToDictionary(k => k.Name, k => k.ClrType);
        Assert.Equal("string", pub["apiUrl"]);
        Assert.Equal("double", pub["retries"]);
        Assert.Equal("string", parsed.SecretKeys.Single().ClrType);
        Assert.Equal("bool", parsed.FeatureFlagKeys.Single().ClrType);
    }

    [Fact]
    public void Parse_EmptyOrInvalidRoot_ReturnsEmpty()
    {
        var parsed = SmooConfigSchemaGenerator.Parse("{}");
        Assert.Empty(parsed.PublicKeys);
        Assert.Empty(parsed.SecretKeys);
        Assert.Empty(parsed.FeatureFlagKeys);
    }

    [Fact]
    public void Render_EmitsAllThreeSectionsAndCorrectNamespace()
    {
        var json = """
            {
              "publicConfigSchema": { "apiUrl": "stringSchema" },
              "secretConfigSchema": { "dbPassword": "stringSchema" },
              "featureFlagSchema":  { "newFlow": "booleanSchema" }
            }
            """;
        var parsed = SmooConfigSchemaGenerator.Parse(json);
        var source = SmooConfigSchemaGenerator.Render(parsed, "My.App.Config");

        Assert.Contains("namespace My.App.Config;", source);
        Assert.Contains("public static class Public", source);
        Assert.Contains("public static class Secrets", source);
        Assert.Contains("public static class FeatureFlags", source);
        Assert.Contains("ConfigKey<string> ApiUrl", source);
        Assert.Contains("ConfigKey<string> DbPassword", source);
        Assert.Contains("ConfigKey<bool> NewFlow", source);
        Assert.Contains("ConfigTier.Public", source);
        Assert.Contains("ConfigTier.Secret", source);
        Assert.Contains("ConfigTier.FeatureFlag", source);
    }

    [Fact]
    public void Render_PascalCasesSnakeAndKebabKeys()
    {
        var json = """
            {
              "publicConfigSchema": {
                "snake_case_key": "stringSchema",
                "kebab-case-key": "stringSchema",
                "camelCaseKey":   "stringSchema",
                "UPPER_SNAKE":    "stringSchema"
              }
            }
            """;
        var parsed = SmooConfigSchemaGenerator.Parse(json);
        var source = SmooConfigSchemaGenerator.Render(parsed, "N");

        Assert.Contains("SnakeCaseKey", source);
        Assert.Contains("KebabCaseKey", source);
        Assert.Contains("CamelCaseKey", source);
        Assert.Contains("UpperSnake", source);
    }
}
