using System.Text.Json;
using SmooAI.Config.Schema;

namespace SmooAI.Config.Tests;

/// <summary>
/// Holds the .NET schema validator to the SAME corpus as TypeScript, Python,
/// Rust and Go: <c>test-fixtures/schema-validation-cases.json</c>.
///
/// The point of loading the shared file rather than re-typing the cases is that
/// a hand-mirrored copy drifts silently — the corpus is only a guarantee while
/// every language actually reads it. Before this, 4 of 7 SDKs did.
/// </summary>
public class SchemaValidatorTests
{
    private sealed record ValidCase(string Name, JsonElement Schema);

    private sealed record InvalidCase(string Name, JsonElement Schema, string[] ExpectedKeywords);

    private static readonly JsonSerializerOptions FixtureOptions = new(JsonSerializerDefaults.Web);

    private static JsonElement LoadFixtures()
    {
        // Copied next to the test assembly by the csproj, so this resolves the
        // same whether run from `dotnet test`, an IDE, or CI.
        var path = Path.Combine(AppContext.BaseDirectory, "test-fixtures", "schema-validation-cases.json");
        Assert.True(File.Exists(path), $"shared fixture not found at {path} — is the csproj still copying it?");

        using var document = JsonDocument.Parse(File.ReadAllBytes(path));
        return document.RootElement.Clone();
    }

    public static TheoryData<string, string> ValidCases()
    {
        var data = new TheoryData<string, string>();
        foreach (var element in LoadFixtures().GetProperty("valid").EnumerateArray())
        {
            data.Add(element.GetProperty("name").GetString()!, element.GetProperty("schema").GetRawText());
        }
        return data;
    }

    public static TheoryData<string, string, string> InvalidCases()
    {
        var data = new TheoryData<string, string, string>();
        foreach (var element in LoadFixtures().GetProperty("invalid").EnumerateArray())
        {
            data.Add(
                element.GetProperty("name").GetString()!,
                element.GetProperty("schema").GetRawText(),
                element.GetProperty("expected_keywords").GetRawText());
        }
        return data;
    }

    [Theory]
    [MemberData(nameof(ValidCases))]
    public void AcceptsEveryValidFixtureCase(string name, string schemaJson)
    {
        using var schema = JsonDocument.Parse(schemaJson);

        var result = SchemaValidator.ValidateSmooaiSchema(schema.RootElement);

        Assert.True(
            result.Valid,
            $"case '{name}' should be valid but reported: {string.Join(", ", result.Errors.Select(e => $"{e.Path}:{e.Keyword}"))}");
        Assert.Empty(result.Errors);
    }

    [Theory]
    [MemberData(nameof(InvalidCases))]
    public void RejectsEveryInvalidFixtureCaseWithTheExpectedKeywords(string name, string schemaJson, string expectedKeywordsJson)
    {
        using var schema = JsonDocument.Parse(schemaJson);
        var expectedKeywords = JsonSerializer.Deserialize<string[]>(expectedKeywordsJson, FixtureOptions)!;

        var result = SchemaValidator.ValidateSmooaiSchema(schema.RootElement);

        Assert.False(result.Valid, $"case '{name}' should be invalid");

        var reported = result.Errors.Select(error => error.Keyword).ToHashSet(StringComparer.Ordinal);
        foreach (var keyword in expectedKeywords)
        {
            Assert.True(reported.Contains(keyword), $"case '{name}' should report keyword '{keyword}', got: {string.Join(", ", reported)}");
        }
    }

    [Fact]
    public void FixtureCoversTheCaseCountTheOtherSdksSee()
    {
        // Guards against a half-copied fixture: if this file is ever truncated
        // or filtered, the theories above would still pass on whatever remained.
        var fixtures = LoadFixtures();
        Assert.Equal(14, fixtures.GetProperty("valid").GetArrayLength());
        Assert.Equal(10, fixtures.GetProperty("invalid").GetArrayLength());
    }

    [Fact]
    public void ReportsUnsupportedFormatWithASuggestion()
    {
        using var schema = JsonDocument.Parse("""{"type":"object","properties":{"when":{"type":"string","format":"date-time"},"who":{"type":"string","format":"hostname"}}}""");

        var result = SchemaValidator.ValidateSmooaiSchema(schema.RootElement);

        var error = Assert.Single(result.Errors);
        Assert.Equal("format", error.Keyword);
        Assert.Equal("/properties/who", error.Path);
        Assert.Contains("hostname", error.Message, StringComparison.Ordinal);
        Assert.Contains("date-time", error.Suggestion, StringComparison.Ordinal);
    }

    [Fact]
    public void ReportsTheRootPathAsSlash()
    {
        using var schema = JsonDocument.Parse("""{"type":"object","not":{"type":"string"}}""");

        var result = SchemaValidator.ValidateSmooaiSchema(schema.RootElement);

        Assert.Equal("/", Assert.Single(result.Errors).Path);
    }
}
