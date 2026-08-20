using SmooAI.Config.Utils;

namespace SmooAI.Config.Tests;

public class MergeReplaceArraysTests
{
    private static Dictionary<string, object?> Dict(params (string Key, object? Value)[] entries)
        => entries.ToDictionary(entry => entry.Key, entry => entry.Value, StringComparer.Ordinal);

    [Fact]
    public void ArraysAreReplacedNotConcatenated()
    {
        var target = Dict(("hosts", new List<object?> { "a", "b", "c" }));
        var source = Dict(("hosts", new List<object?> { "z" }));

        var merged = (IReadOnlyDictionary<string, object?>)MergeReplaceArrays.Merge(target, source)!;

        // The whole reason this helper exists: a concat would resurrect "a"/"b"/"c"
        // that the override meant to drop.
        Assert.Equal(new List<object?> { "z" }, merged["hosts"]);
    }

    [Fact]
    public void ObjectsMergeRecursively()
    {
        var target = Dict(("db", Dict(("host", "localhost"), ("port", 5432))));
        var source = Dict(("db", Dict(("host", "prod.example"))));

        var merged = (IReadOnlyDictionary<string, object?>)MergeReplaceArrays.Merge(target, source)!;
        var db = (IReadOnlyDictionary<string, object?>)merged["db"]!;

        Assert.Equal("prod.example", db["host"]);
        Assert.Equal(5432, db["port"]);
    }

    [Fact]
    public void PrimitivesFromSourceWin()
    {
        Assert.Equal(2, MergeReplaceArrays.Merge(1, 2));
        Assert.Equal("new", MergeReplaceArrays.Merge("old", "new"));
        Assert.Null(MergeReplaceArrays.Merge("old", null));
    }

    [Fact]
    public void KeysOnlyInTargetSurvive()
    {
        var merged = (IReadOnlyDictionary<string, object?>)MergeReplaceArrays.Merge(Dict(("keep", 1)), Dict(("add", 2)))!;

        Assert.Equal(1, merged["keep"]);
        Assert.Equal(2, merged["add"]);
    }

    [Fact]
    public void DoesNotMutateTheInputs()
    {
        var target = Dict(("db", Dict(("host", "localhost"))));
        var source = Dict(("db", Dict(("host", "prod.example"))));

        MergeReplaceArrays.Merge(target, source);

        Assert.Equal("localhost", ((IReadOnlyDictionary<string, object?>)target["db"]!)["host"]);
    }

    [Fact]
    public void StringsAreTreatedAsPrimitivesNotCharacterLists()
    {
        // string implements IEnumerable; if the list branch caught it, "abc"
        // would merge into a list of characters.
        Assert.Equal("abc", MergeReplaceArrays.Merge(new List<object?> { "x" }, "abc"));
    }
}
