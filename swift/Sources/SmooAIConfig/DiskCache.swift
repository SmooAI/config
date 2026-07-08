import Foundation

/// Offline cache for the mobile runtime mode: last-known public values and
/// last evaluation result per flag/limit key. Plain JSON file in the caches
/// directory — PUBLIC-tier data only ever flows through this surface, so no
/// encryption is needed (mirror of the plaintext baked bundle rationale in
/// ADR-073).
struct DiskCache {
    private struct Payload: Codable {
        var publicValues: [String: JSONValue]?
        var evaluations: [String: EvaluationResult] = [:]
    }

    private let fileURL: URL?
    private var payload: Payload

    init(directory: URL?) {
        let dir = directory ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        self.fileURL = dir?.appendingPathComponent("smooai-config-cache.json")
        if let url = fileURL,
           let data = try? Data(contentsOf: url),
           let decoded = try? JSONDecoder().decode(Payload.self, from: data) {
            self.payload = decoded
        } else {
            self.payload = Payload()
        }
    }

    func publicValues() -> [String: JSONValue]? {
        payload.publicValues
    }

    mutating func storePublicValues(_ values: [String: JSONValue]) {
        payload.publicValues = values
        persist()
    }

    func evaluation(kind: String, key: String) -> EvaluationResult? {
        payload.evaluations["\(kind):\(key)"]
    }

    mutating func storeEvaluation(kind: String, key: String, result: EvaluationResult) {
        payload.evaluations["\(kind):\(key)"] = result
        persist()
    }

    private func persist() {
        guard let url = fileURL, let data = try? JSONEncoder().encode(payload) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
