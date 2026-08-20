using SmooAI.Config.Config;

namespace SmooAI.Config.Tests;

public class DeferredValuesTests
{
    [Fact]
    public void ResolvesAgainstTheMergedConfig()
    {
        var config = new Dictionary<string, object?>(StringComparer.Ordinal) { ["host"] = "example.com", ["url"] = null };

        DeferredValues.Resolve(config, new Dictionary<string, DeferredValue>(StringComparer.Ordinal)
        {
            ["url"] = snapshot => $"https://{snapshot["host"]}",
        });

        Assert.Equal("https://example.com", config["url"]);
    }

    [Fact]
    public void EveryResolverSeesThePreResolutionSnapshot()
    {
        // Order-independence is the contract: `second` must observe the ORIGINAL
        // value of `first`, never `first`'s resolved output. Otherwise the result
        // would depend on dictionary iteration order.
        var config = new Dictionary<string, object?>(StringComparer.Ordinal) { ["first"] = "original", ["second"] = null };

        DeferredValues.Resolve(config, new Dictionary<string, DeferredValue>(StringComparer.Ordinal)
        {
            ["first"] = _ => "resolved",
            ["second"] = snapshot => snapshot["first"],
        });

        Assert.Equal("resolved", config["first"]);
        Assert.Equal("original", config["second"]);
    }

    [Fact]
    public void AddsKeysThatWereNotAlreadyPresent()
    {
        var config = new Dictionary<string, object?>(StringComparer.Ordinal) { ["port"] = 8080 };

        DeferredValues.Resolve(config, new Dictionary<string, DeferredValue>(StringComparer.Ordinal)
        {
            ["addr"] = snapshot => $":{snapshot["port"]}",
        });

        Assert.Equal(":8080", config["addr"]);
    }

    [Fact]
    public void EmptyDeferredMapLeavesConfigUntouched()
    {
        var config = new Dictionary<string, object?>(StringComparer.Ordinal) { ["a"] = 1 };

        DeferredValues.Resolve(config, new Dictionary<string, DeferredValue>(StringComparer.Ordinal));

        Assert.Single(config);
        Assert.Equal(1, config["a"]);
    }

    [Fact]
    public void AResolverMayReturnNull()
    {
        var config = new Dictionary<string, object?>(StringComparer.Ordinal) { ["a"] = 1 };

        DeferredValues.Resolve(config, new Dictionary<string, DeferredValue>(StringComparer.Ordinal) { ["a"] = _ => null });

        Assert.Null(config["a"]);
    }
}
