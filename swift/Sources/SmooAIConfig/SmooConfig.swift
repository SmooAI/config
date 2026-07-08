import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Result of a server-side flag/limit evaluation — mirrors
/// `EvaluateFeatureFlagResponse` in the TS reference implementation.
public struct EvaluationResult: Sendable, Codable, Equatable {
    public let value: JSONValue
    public let matchedRuleId: String?
    public let rolloutBucket: Int?
    public let source: String

    public init(value: JSONValue, matchedRuleId: String? = nil, rolloutBucket: Int? = nil, source: String) {
        self.value = value
        self.matchedRuleId = matchedRuleId
        self.rolloutBucket = rolloutBucket
        self.source = source
    }
}

/// Options for `SmooConfig` — the mobile runtime mode of @smooai/config
/// (ADR-074). Public config arrives via a build-time-baked bundle plus an
/// optional HTTP refresh; flags/limits are always evaluated live against the
/// app-config surface (`/config/app/*`) with the Supabase user JWT.
public struct SmooConfigOptions: Sendable {
    public var apiURL: URL
    public var environment: String
    /// Baked public-config bundle (`{"values": {...}}`) — the build step ships
    /// this inside the app. `nil` is allowed (tests, previews) but production
    /// apps should always bundle one.
    public var bundledConfigURL: URL?
    /// Supplies the caller's bearer token (Supabase user JWT). Flags/limits
    /// fall back to cached/default values when nil (signed-out).
    public var tokenProvider: (@Sendable () async -> String?)?
    public var session: URLSession
    /// Directory for the offline cache. Defaults to the user caches directory.
    public var cacheDirectory: URL?

    public init(
        apiURL: URL = URL(string: "https://api.smoo.ai")!,
        environment: String,
        bundledConfigURL: URL? = nil,
        tokenProvider: (@Sendable () async -> String?)? = nil,
        session: URLSession = .shared,
        cacheDirectory: URL? = nil
    ) {
        self.apiURL = apiURL
        self.environment = environment
        self.bundledConfigURL = bundledConfigURL
        self.tokenProvider = tokenProvider
        self.session = session
        self.cacheDirectory = cacheDirectory
    }
}

/// Errors thrown by `SmooConfig`. The evaluate cases mirror the TS/Rust typed
/// error hierarchies (`FeatureFlagNotFoundError` / `...ContextError` /
/// `...EvaluationError` and the `Limit*` siblings) so callers can branch on
/// 404 (key not in schema) / 400 (bad context) / other without parsing
/// messages — the key rides along on every case.
public enum SmooConfigError: Error, Equatable {
    case httpStatus(Int)
    case invalidResponse
    /// Server returned 404 — the flag key is not defined in the schema.
    case featureFlagNotFound(key: String)
    /// Server returned 400 — invalid context or missing environment.
    case featureFlagContext(key: String)
    /// Any other non-2xx from the flag evaluator.
    case featureFlagEvaluation(key: String, statusCode: Int)
    /// Server returned 404 — the limit key is not defined in the schema.
    case limitNotFound(key: String)
    /// Server returned 400 — invalid context or missing environment.
    case limitContext(key: String)
    /// Any other non-2xx from the limit evaluator.
    case limitEvaluation(key: String, statusCode: Int)
}

/// Mobile runtime mode client (ADR-074, SMOODEV-2380).
///
/// Read chains — offline-safe by construction, every accessor resolves
/// without network:
/// - public config: baked bundle → http-refreshed cache → nil
/// - feature flags / limits: http → last-cached value (disk) → caller default
///
/// This client speaks the app-config surface (`/config/app/*`): the server
/// pins the evaluation org to the Smoo AI master org and serves ONLY
/// public-tier values — there is no secret access on this path by design.
///
/// A lock-guarded class rather than an actor so `publicValue(forKey:)` stays
/// callable synchronously (spec row 2: boot config resolves without await) —
/// the structural twin of the Kotlin SDK's `@Volatile` + `@Synchronized`.
public final class SmooConfig: @unchecked Sendable {
    private let options: SmooConfigOptions
    private let bundledValues: [String: JSONValue]
    private let lock = NSLock()
    private var refreshedValues: [String: JSONValue]? = nil
    private var cache: DiskCache

    public init(options: SmooConfigOptions) {
        self.options = options
        self.cache = DiskCache(directory: options.cacheDirectory)
        self.bundledValues = options.bundledConfigURL.flatMap(Self.loadBundle) ?? [:]
    }

    private static func loadBundle(_ url: URL) -> [String: JSONValue]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let decoded = try? JSONDecoder().decode(ValuesResponse.self, from: data)
        return decoded?.values
    }

    // MARK: - Public config

    /// Baked-bundle-first read; an http-refreshed map (if `refreshPublicValues`
    /// has succeeded this launch or a previous one) wins over the bundle.
    /// Synchronous and offline-safe (spec row 2).
    public func publicValue(forKey key: String) -> JSONValue? {
        lock.lock()
        defer { lock.unlock() }
        if let refreshed = refreshedValues ?? cache.publicValues() {
            if let value = refreshed[key] { return value }
        }
        return bundledValues[key]
    }

    /// Fetches the current public values from the server and persists them to
    /// the offline cache. Failures throw; baked values remain authoritative.
    public func refreshPublicValues() async throws {
        let url = options.apiURL
            .appendingPathComponent("config/app/values")
            .appending(queryItems: [URLQueryItem(name: "environment", value: options.environment)])
        let response: ValuesResponse = try await get(url)
        lock.lock()
        defer { lock.unlock() }
        refreshedValues = response.values
        cache.storePublicValues(response.values)
    }

    // MARK: - Feature flags

    /// Full evaluation result from the server. Throws on network/auth failure —
    /// most callers want `evaluateFlag(_:context:default:)` instead.
    public func evaluateFlagValue(_ key: String, context: [String: JSONValue] = [:]) async throws -> EvaluationResult {
        let result: EvaluationResult = try await evaluate(kind: "feature-flags", key: key, context: context)
        storeEvaluation(kind: "flag", key: key, result: result)
        return result
    }

    /// Offline-safe boolean flag read: live evaluation → last cached value →
    /// the caller's default. Never throws.
    public func evaluateFlag(_ key: String, context: [String: JSONValue] = [:], default defaultValue: Bool) async -> Bool {
        if let result = try? await evaluateFlagValue(key, context: context), let value = result.value.boolValue {
            return value
        }
        if let cached = cachedEvaluation(kind: "flag", key: key), let value = cached.value.boolValue {
            return value
        }
        return defaultValue
    }

    // MARK: - Limits

    /// Full limit evaluation (raw number, pre-clamp). Throws on failure.
    public func evaluateLimitValue(_ key: String, context: [String: JSONValue] = [:]) async throws -> EvaluationResult {
        let result: EvaluationResult = try await evaluate(kind: "limits", key: key, context: context)
        storeEvaluation(kind: "limit", key: key, result: result)
        return result
    }

    /// Offline-safe clamped limit read: live → cached → default. `step` (if
    /// set) snaps to the nearest multiple BEFORE the `[min, max]` clamp — the
    /// same order as the TS `clampLimit` / Rust `clamp_limit` (ADR-066).
    public func evaluateLimit(
        _ key: String,
        context: [String: JSONValue] = [:],
        default defaultValue: Double,
        min minValue: Double? = nil,
        max maxValue: Double? = nil,
        step: Double? = nil
    ) async -> Double {
        var value = defaultValue
        if let result = try? await evaluateLimitValue(key, context: context), let number = result.value.numberValue {
            value = number
        } else if let cached = cachedEvaluation(kind: "limit", key: key), let number = cached.value.numberValue {
            value = number
        }
        if let step, step > 0 { value = (value / step).rounded() * step }
        if let minValue { value = Swift.max(value, minValue) }
        if let maxValue { value = Swift.min(value, maxValue) }
        return value
    }

    // MARK: - Cache (lock-guarded)

    private func cachedEvaluation(kind: String, key: String) -> EvaluationResult? {
        lock.lock()
        defer { lock.unlock() }
        return cache.evaluation(kind: kind, key: key)
    }

    private func storeEvaluation(kind: String, key: String, result: EvaluationResult) {
        lock.lock()
        defer { lock.unlock() }
        cache.storeEvaluation(kind: kind, key: key, result: result)
    }

    // MARK: - HTTP

    private struct ValuesResponse: Codable {
        let values: [String: JSONValue]
    }

    private struct EvaluateRequest: Codable {
        let environment: String
        let context: [String: JSONValue]
    }

    private func evaluate(kind: String, key: String, context: [String: JSONValue]) async throws -> EvaluationResult {
        guard let encodedKey = key.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else {
            throw SmooConfigError.invalidResponse
        }
        let url = options.apiURL.appendingPathComponent("config/app/\(kind)/\(encodedKey)/evaluate")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(EvaluateRequest(environment: options.environment, context: context))
        do {
            return try await send(request)
        } catch SmooConfigError.httpStatus(let status) {
            switch (kind, status) {
            case ("feature-flags", 404): throw SmooConfigError.featureFlagNotFound(key: key)
            case ("feature-flags", 400): throw SmooConfigError.featureFlagContext(key: key)
            case ("feature-flags", _): throw SmooConfigError.featureFlagEvaluation(key: key, statusCode: status)
            case (_, 404): throw SmooConfigError.limitNotFound(key: key)
            case (_, 400): throw SmooConfigError.limitContext(key: key)
            default: throw SmooConfigError.limitEvaluation(key: key, statusCode: status)
            }
        }
    }

    private func get<T: Decodable>(_ url: URL) async throws -> T {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        return try await send(request)
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        var request = request
        if let token = await options.tokenProvider?() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await options.session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw SmooConfigError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw SmooConfigError.httpStatus(http.statusCode) }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
