using System.Collections.Immutable;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Text;
using SmooAI.Config.SourceGenerator;

namespace SmooAI.Config.SourceGenerator.Tests;

public class GeneratorRunnerTests
{
    [Fact]
    public void Generator_EmitsFileForAdditionalSchemaJson()
    {
        var schema = """
            {
              "publicConfigSchema": { "apiUrl": "stringSchema" },
              "secretConfigSchema": { "dbPassword": "stringSchema" },
              "featureFlagSchema":  { "newFlow":  "booleanSchema" }
            }
            """;

        var compilation = CSharpCompilation.Create(
            assemblyName: "ConsumerAssembly",
            syntaxTrees: new[] { CSharpSyntaxTree.ParseText("namespace ConsumerAssembly;") },
            references: AppDomain.CurrentDomain.GetAssemblies()
                .Where(a => !a.IsDynamic && !string.IsNullOrEmpty(a.Location))
                .Select(a => MetadataReference.CreateFromFile(a.Location))
                .Cast<MetadataReference>()
                .ToArray(),
            options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var additionalText = new InMemoryAdditionalText("schema.json", schema);
        var optionsProvider = new TestAnalyzerConfigOptionsProvider(
            new Dictionary<string, string>
            {
                ["build_metadata.AdditionalFiles.SmooConfigSchema"] = "true",
                ["build_metadata.AdditionalFiles.SmooConfigNamespace"] = "ConsumerAssembly.Config",
            });

        var driver = CSharpGeneratorDriver
            .Create(new SmooConfigSchemaGenerator())
            .AddAdditionalTexts(ImmutableArray.Create<AdditionalText>(additionalText))
            .WithUpdatedAnalyzerConfigOptions(optionsProvider)
            .RunGenerators(compilation);

        var result = driver.GetRunResult();
        Assert.Empty(result.Diagnostics);
        Assert.Single(result.GeneratedTrees);

        var generated = result.GeneratedTrees.Single().ToString();
        Assert.Contains("namespace ConsumerAssembly.Config;", generated);
        Assert.Contains("ConfigKey<string> ApiUrl", generated);
        Assert.Contains("ConfigKey<string> DbPassword", generated);
        Assert.Contains("ConfigKey<bool> NewFlow", generated);
    }

    [Fact]
    public void Generator_ReportsDiagnosticOnInvalidJson()
    {
        var compilation = CSharpCompilation.Create(
            assemblyName: "ConsumerAssembly",
            syntaxTrees: new[] { CSharpSyntaxTree.ParseText("namespace ConsumerAssembly;") },
            references: Array.Empty<MetadataReference>(),
            options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var additionalText = new InMemoryAdditionalText("schema.json", "{ not valid json");
        var optionsProvider = new TestAnalyzerConfigOptionsProvider(
            new Dictionary<string, string>
            {
                ["build_metadata.AdditionalFiles.SmooConfigSchema"] = "true",
            });

        var driver = CSharpGeneratorDriver
            .Create(new SmooConfigSchemaGenerator())
            .AddAdditionalTexts(ImmutableArray.Create<AdditionalText>(additionalText))
            .WithUpdatedAnalyzerConfigOptions(optionsProvider)
            .RunGenerators(compilation);

        var result = driver.GetRunResult();
        Assert.Contains(result.Diagnostics, d => d.Id == "SMOOCFG001");
    }

    private sealed class InMemoryAdditionalText : AdditionalText
    {
        public override string Path { get; }
        private readonly SourceText _text;
        public InMemoryAdditionalText(string path, string content)
        {
            Path = path;
            _text = SourceText.From(content);
        }
        public override SourceText GetText(CancellationToken cancellationToken = default) => _text;
    }

    private sealed class TestAnalyzerConfigOptionsProvider : AnalyzerConfigOptionsProvider
    {
        private readonly Dictionary<string, string> _map;
        public TestAnalyzerConfigOptionsProvider(Dictionary<string, string> map) { _map = map; }
        public override AnalyzerConfigOptions GlobalOptions => new TestOptions(new Dictionary<string, string>());
        public override AnalyzerConfigOptions GetOptions(SyntaxTree tree) => new TestOptions(new Dictionary<string, string>());
        public override AnalyzerConfigOptions GetOptions(AdditionalText textFile) => new TestOptions(_map);

        private sealed class TestOptions : AnalyzerConfigOptions
        {
            private readonly Dictionary<string, string> _map;
            public TestOptions(Dictionary<string, string> map) { _map = map; }
            public override bool TryGetValue(string key, out string value)
            {
                if (_map.TryGetValue(key, out var v)) { value = v; return true; }
                value = null!;
                return false;
            }
        }
    }
}
