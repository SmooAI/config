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

    // No `await`: publicValue is synchronous by contract (spec row 2 — boot
    // config resolves without suspension), matching the Kotlin twin.
    func testBundledPublicValueResolvesSynchronously() {
        let config = makeConfig(bundle: #"{"values":{"supabaseHost":"db.smoo.ai","retries":3}}"#)
        XCTAssertEqual(config.publicValue(forKey: "supabaseHost")?.stringValue, "db.smoo.ai")
        XCTAssertEqual(config.publicValue(forKey: "retries")?.numberValue, 3)
        XCTAssertNil(config.publicValue(forKey: "nope"))
    }

    func testRefreshedValuesWinOverBundle() async throws {
        StubURLProtocol.handlers = [("/config/app/values", 200, #"{"values":{"supabaseHost":"db2.smoo.ai"}}"#)]
        let config = makeConfig(bundle: #"{"values":{"supabaseHost":"db.smoo.ai"}}"#)
        try await config.refreshPublicValues()
        XCTAssertEqual(config.publicValue(forKey: "supabaseHost")?.stringValue, "db2.smoo.ai")
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
        XCTAssertEqual(config.publicValue(forKey: "supabaseHost")?.stringValue, "db.smoo.ai")
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

    func testLimitStepSnapsBeforeClamp() async {
        // 118 with step 25 snaps to 125 first, THEN clamps to max 120 — the
        // TS clampLimit / Rust clamp_limit order (ADR-066).
        StubURLProtocol.handlers = [("/config/app/limits/syncInterval/evaluate", 200, #"{"value":118,"source":"rule"}"#)]
        let config = makeConfig()
        let clamped = await config.evaluateLimit("syncInterval", default: 30, min: 5, max: 120, step: 25)
        XCTAssertEqual(clamped, 120)

        // In-bounds snap: 47 with step 10 → 50.
        StubURLProtocol.handlers = [("/config/app/limits/batchSize/evaluate", 200, #"{"value":47,"source":"raw"}"#)]
        let snapped = await config.evaluateLimit("batchSize", default: 10, min: 0, max: 100, step: 10)
        XCTAssertEqual(snapped, 50)
    }

    // MARK: - Typed evaluate errors

    func testEvaluateThrowsTypedErrors() async {
        StubURLProtocol.handlers = [
            ("/config/app/feature-flags/missingFlag/evaluate", 404, "{}"),
            ("/config/app/feature-flags/badContext/evaluate", 400, "{}"),
            ("/config/app/limits/missingLimit/evaluate", 404, "{}"),
            ("/config/app/limits/brokenLimit/evaluate", 503, "{}"),
        ]
        let config = makeConfig()

        do {
            _ = try await config.evaluateFlagValue("missingFlag")
            XCTFail("expected throw")
        } catch let error as SmooConfigError {
            XCTAssertEqual(error, .featureFlagNotFound(key: "missingFlag"))
        } catch { XCTFail("unexpected error \(error)") }

        do {
            _ = try await config.evaluateFlagValue("badContext")
            XCTFail("expected throw")
        } catch let error as SmooConfigError {
            XCTAssertEqual(error, .featureFlagContext(key: "badContext"))
        } catch { XCTFail("unexpected error \(error)") }

        do {
            _ = try await config.evaluateLimitValue("missingLimit")
            XCTFail("expected throw")
        } catch let error as SmooConfigError {
            XCTAssertEqual(error, .limitNotFound(key: "missingLimit"))
        } catch { XCTFail("unexpected error \(error)") }

        do {
            _ = try await config.evaluateLimitValue("brokenLimit")
            XCTFail("expected throw")
        } catch let error as SmooConfigError {
            XCTAssertEqual(error, .limitEvaluation(key: "brokenLimit", statusCode: 503))
        } catch { XCTFail("unexpected error \(error)") }
    }
}
