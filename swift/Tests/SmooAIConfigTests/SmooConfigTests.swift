import XCTest
@testable import SmooAIConfig
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// URLProtocol stub — canned responses keyed by path suffix, mirroring the
/// consuming apps' StubURLProtocol test pattern.
final class StubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handlers: [(suffix: String, status: Int, body: String)] = []
    nonisolated(unsafe) static var requests: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.requests.append(request)
        let path = request.url?.path ?? ""
        guard let handler = Self.handlers.first(where: { path.hasSuffix($0.suffix) }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: handler.status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: handler.body.data(using: .utf8)!)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    static func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: config)
    }

    static func reset() {
        handlers = []
        requests = []
    }
}

final class SmooConfigTests: XCTestCase {
    var tempDir: URL!

    override func setUp() {
        super.setUp()
        StubURLProtocol.reset()
        tempDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
        super.tearDown()
    }

    private func writeBundle(_ json: String) -> URL {
        let url = tempDir.appendingPathComponent("smooai-config.json")
        try! json.data(using: .utf8)!.write(to: url)
        return url
    }

    private func makeConfig(bundle: String? = nil, token: String? = "user-jwt") -> SmooConfig {
        let bundleURL = bundle.map { writeBundle($0) }
        return SmooConfig(options: SmooConfigOptions(
            apiURL: URL(string: "https://api.example.test")!,
            environment: "production",
            bundledConfigURL: bundleURL,
            tokenProvider: token.map { jwt in { jwt } },
            session: StubURLProtocol.session(),
            cacheDirectory: tempDir
        ))
    }

    // MARK: - Public config

    func testBundledPublicValue() async {
        let config = makeConfig(bundle: #"{"values":{"supabaseHost":"db.smoo.ai","retries":3}}"#)
        let host = await config.publicValue(forKey: "supabaseHost")
        XCTAssertEqual(host?.stringValue, "db.smoo.ai")
        let retries = await config.publicValue(forKey: "retries")
        XCTAssertEqual(retries?.numberValue, 3)
        let missing = await config.publicValue(forKey: "nope")
        XCTAssertNil(missing)
    }

    func testRefreshedValuesWinOverBundle() async throws {
        StubURLProtocol.handlers = [("/config/app/values", 200, #"{"values":{"supabaseHost":"db2.smoo.ai"}}"#)]
        let config = makeConfig(bundle: #"{"values":{"supabaseHost":"db.smoo.ai"}}"#)
        try await config.refreshPublicValues()
        let host = await config.publicValue(forKey: "supabaseHost")
        XCTAssertEqual(host?.stringValue, "db2.smoo.ai")
        // Bearer token attached
        let auth = StubURLProtocol.requests.first?.value(forHTTPHeaderField: "Authorization")
        XCTAssertEqual(auth, "Bearer user-jwt")
    }

    func testRefreshFailureKeepsBundle() async {
        StubURLProtocol.handlers = [("/config/app/values", 500, "{}")]
        let config = makeConfig(bundle: #"{"values":{"supabaseHost":"db.smoo.ai"}}"#)
        do {
            try await config.refreshPublicValues()
            XCTFail("expected throw")
        } catch {}
        let host = await config.publicValue(forKey: "supabaseHost")
        XCTAssertEqual(host?.stringValue, "db.smoo.ai")
    }

    // MARK: - Feature flags

    func testFlagEvaluationLive() async {
        StubURLProtocol.handlers = [("/config/app/feature-flags/mobilePush/evaluate", 200, #"{"value":true,"source":"rollout","rolloutBucket":7}"#)]
        let config = makeConfig()
        let enabled = await config.evaluateFlag("mobilePush", context: ["platform": .string("ios")], default: false)
        XCTAssertTrue(enabled)
    }

    func testFlagFallsBackToCacheThenDefault() async {
        // First: live success populates the cache.
        StubURLProtocol.handlers = [("/config/app/feature-flags/mobilePush/evaluate", 200, #"{"value":true,"source":"default"}"#)]
        let config = makeConfig()
        _ = await config.evaluateFlag("mobilePush", default: false)

        // Then: server down → cached value survives (fresh client, same cache dir).
        StubURLProtocol.handlers = [("/config/app/feature-flags/mobilePush/evaluate", 500, "{}")]
        let offline = makeConfig()
        let cached = await offline.evaluateFlag("mobilePush", default: false)
        XCTAssertTrue(cached)

        // Unknown key with server down → caller default.
        let fallback = await offline.evaluateFlag("neverSeen", default: true)
        XCTAssertTrue(fallback)
    }

    // MARK: - Limits

    func testLimitEvaluationClamps() async {
        StubURLProtocol.handlers = [("/config/app/limits/syncInterval/evaluate", 200, #"{"value":600,"source":"rule","matchedRuleId":"r1"}"#)]
        let config = makeConfig()
        let clamped = await config.evaluateLimit("syncInterval", default: 30, min: 5, max: 120)
        XCTAssertEqual(clamped, 120)
    }

    func testLimitDefaultWhenOffline() async {
        let config = makeConfig()
        let value = await config.evaluateLimit("syncInterval", default: 30, min: 5, max: 120)
        XCTAssertEqual(value, 30)
    }
}
