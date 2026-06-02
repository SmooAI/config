using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using SmooAI.Config.Eso;

namespace SmooAI.Config.Tests;

// SMOODEV-1526 — ESO refresher core parity tests (C#).
public class EsoRefresherTests
{
    private sealed class FakeTokenSource : ITokenSource
    {
        private readonly string[] _tokens;
        private int _idx;
        public int Calls;
        public int Invalidations;

        public FakeTokenSource(params string[] tokens) => _tokens = tokens;

        public Task<string> GetAccessTokenAsync(CancellationToken cancellationToken = default)
        {
            Calls++;
            var t = _tokens[Math.Min(_idx, _tokens.Length - 1)];
            _idx++;
            return Task.FromResult(t);
        }

        public void Invalidate() => Invalidations++;
    }

    private sealed class RecordingWriter : ISecretWriter
    {
        private readonly int _failOnCall;
        private int _call;
        public readonly List<string> Written = new();

        public RecordingWriter(int failOnCall = -1) => _failOnCall = failOnCall;

        public Task PatchBearerTokenAsync(string token, CancellationToken cancellationToken = default)
        {
            _call++;
            if (_call == _failOnCall) throw new InvalidOperationException("simulated k8s patch failure");
            Written.Add(token);
            return Task.CompletedTask;
        }
    }

    [Fact]
    public async Task RefreshOnce_WritesFreshToken()
    {
        var ts = new FakeTokenSource("tok-1");
        var w = new RecordingWriter();
        var r = new EsoRefresher(ts, w);
        await r.RefreshOnceAsync();
        Assert.Equal(1, ts.Invalidations);
        Assert.Equal(new List<string> { "tok-1" }, w.Written);
    }

    [Fact]
    public async Task ForcesFreshEachCycle()
    {
        var ts = new FakeTokenSource("tok-1", "tok-2");
        var w = new RecordingWriter();
        var r = new EsoRefresher(ts, w);
        await r.RefreshOnceAsync();
        await r.RefreshOnceAsync();
        Assert.Equal(2, ts.Calls);
        Assert.Equal(2, ts.Invalidations);
        Assert.Equal(new List<string> { "tok-1", "tok-2" }, w.Written);
    }

    [Fact]
    public async Task RefreshOnce_PropagatesWriteFailure()
    {
        var ts = new FakeTokenSource("tok-1");
        var w = new RecordingWriter(failOnCall: 1);
        var r = new EsoRefresher(ts, w);
        await Assert.ThrowsAsync<InvalidOperationException>(() => r.RefreshOnceAsync());
    }

    [Fact]
    public void RequiredFields()
    {
        Assert.Throws<ArgumentException>(() => new EsoRefresher(null!, new RecordingWriter()));
        Assert.Throws<ArgumentException>(() => new EsoRefresher(new FakeTokenSource("t"), null!));
    }

    [Fact]
    public void DefaultsIntervalWhenZero()
    {
        var r = new EsoRefresher(new FakeTokenSource("t"), new RecordingWriter());
        Assert.Equal(TimeSpan.FromSeconds(EsoRefresher.DefaultIntervalSeconds), r.Interval);
    }
}
