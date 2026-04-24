using System.Net;
using System.Net.Http;

namespace SmooAI.Config.Tests;

/// <summary>
/// Scripted HTTP handler for unit tests. Queues responses and records every
/// request so tests can assert on path + body without a real server.
/// </summary>
internal sealed class StubHttpMessageHandler : HttpMessageHandler
{
    private readonly Queue<Func<HttpRequestMessage, HttpResponseMessage>> _responders = new();
    public List<HttpRequestMessage> Requests { get; } = new();
    public List<string> RequestBodies { get; } = new();

    public void Enqueue(HttpStatusCode status, string body, string mediaType = "application/json")
    {
        _responders.Enqueue(_ => new HttpResponseMessage(status)
        {
            Content = new StringContent(body, System.Text.Encoding.UTF8, mediaType),
        });
    }

    public void Enqueue(Func<HttpRequestMessage, HttpResponseMessage> factory) => _responders.Enqueue(factory);

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Requests.Add(request);
        RequestBodies.Add(request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false));

        if (_responders.Count == 0)
        {
            throw new InvalidOperationException($"No queued response for {request.Method} {request.RequestUri}");
        }
        return _responders.Dequeue()(request);
    }
}
