// Kolm.swift — one-line embed for .kolm artifacts on Apple platforms.
//
// Public surface:
//
//   let model = try Kolm.load(named: "phi-redactor")
//   let out = try model.predict("text")
//
// Everything else is configuration on `Kolm.Configuration.shared`.

import Foundation
import CryptoKit

public enum KolmError: Error, CustomStringConvertible {
    case missingArtifact(String)
    case missingManifest
    case missingReceipt
    case verificationFailed(String)
    case noRuntimeAvailable
    case runtimeFailure(String)

    public var description: String {
        switch self {
        case .missingArtifact(let n): return "missing artifact: \(n)"
        case .missingManifest:        return "manifest.json missing in artifact"
        case .missingReceipt:         return "receipt.json missing in artifact"
        case .verificationFailed(let r): return "verification failed: \(r)"
        case .noRuntimeAvailable:     return "no compatible runtime; export with --backend coreml|mlx|gguf"
        case .runtimeFailure(let r):  return "runtime failure: \(r)"
        }
    }
}

public struct KolmOutput {
    public let text: String
    public let cid: String?
    public let credential: String?
    public let latencyMs: Double
}

public enum VerifyMode {
    case off, on, strict
}

public final class KolmConfiguration {
    public static let shared = KolmConfiguration()
    public var verify: VerifyMode = .on
    public var secret: Data? = nil
    private init() {}
}

public final class KolmModel {
    public let cid: String?
    public let task: String?
    public let baseModel: String?
    public let kScore: Double?
    public let credentialId: String?

    private let workDir: URL
    private let backend: Backend

    fileprivate init(workDir: URL, manifest: [String: Any], credential: [String: Any]?, backend: Backend) {
        self.workDir = workDir
        self.cid = manifest["cid"] as? String
        self.task = manifest["task"] as? String
        self.baseModel = manifest["base_model"] as? String
        let metrics = manifest["metrics"] as? [String: Any]
        self.kScore = metrics?["k_score"] as? Double
        self.credentialId = credential?["credential_id"] as? String
        self.backend = backend
    }

    public func predict(_ text: String, maxTokens: Int = 256) throws -> KolmOutput {
        let start = Date()
        let out = try backend.generate(prompt: text, maxTokens: maxTokens)
        return KolmOutput(
            text: out,
            cid: cid,
            credential: credentialId,
            latencyMs: Date().timeIntervalSince(start) * 1000
        )
    }
}

public enum Kolm {
    /// Load by file name from the main bundle.
    public static func load(named name: String, bundle: Bundle = .main) throws -> KolmModel {
        let stem = name.hasSuffix(".kolm") ? String(name.dropLast(5)) : name
        guard let url = bundle.url(forResource: stem, withExtension: "kolm") else {
            throw KolmError.missingArtifact(name)
        }
        return try load(at: url)
    }

    /// Load from an arbitrary URL.
    public static func load(at url: URL) throws -> KolmModel {
        let fm = FileManager.default
        let work = fm.temporaryDirectory.appendingPathComponent("kolm-\(UUID().uuidString)")
        try fm.createDirectory(at: work, withIntermediateDirectories: true)
        try Unzip.expand(zipURL: url, to: work)

        let manifestURL = work.appendingPathComponent("manifest.json")
        guard fm.fileExists(atPath: manifestURL.path),
              let manifestData = try? Data(contentsOf: manifestURL),
              let manifest = try? JSONSerialization.jsonObject(with: manifestData) as? [String: Any]
        else { throw KolmError.missingManifest }

        if KolmConfiguration.shared.verify != .off, let cid = manifest["cid"] as? String,
           let hashes = manifest["hashes"] {
            let expected = computeCid(hashes: hashes)
            if cid != expected {
                throw KolmError.verificationFailed("manifest CID \(cid) != \(expected)")
            }
        }

        let receiptURL = work.appendingPathComponent("receipt.json")
        if let receiptData = try? Data(contentsOf: receiptURL),
           let receipt = try? JSONSerialization.jsonObject(with: receiptData) as? [String: Any] {
            try verifyReceipt(receipt: receipt)
        } else if KolmConfiguration.shared.verify == .strict {
            throw KolmError.missingReceipt
        }

        let credURL = work.appendingPathComponent("credential.json")
        let credential = (try? Data(contentsOf: credURL))
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }

        let backend = try Backend.pick(workDir: work, manifest: manifest)
        return KolmModel(workDir: work, manifest: manifest, credential: credential, backend: backend)
    }

    // MARK: - verification

    private static func verifyReceipt(receipt: [String: Any]) throws {
        guard KolmConfiguration.shared.verify != .off else { return }
        guard let signature = receipt["signature"] as? String else {
            if KolmConfiguration.shared.verify == .strict {
                throw KolmError.verificationFailed("receipt has no signature")
            }
            return
        }
        guard let secret = KolmConfiguration.shared.secret else {
            if KolmConfiguration.shared.verify == .strict {
                throw KolmError.verificationFailed("strict verify requires Kolm.Configuration.shared.secret")
            }
            return
        }
        var body = receipt
        body.removeValue(forKey: "signature")
        let canonical = CanonicalJSON.encode(body)
        let key = SymmetricKey(data: secret)
        let mac = HMAC<SHA256>.authenticationCode(for: Data(canonical.utf8), using: key)
        let expected = mac.map { String(format: "%02x", $0) }.joined()
        if expected != signature {
            throw KolmError.verificationFailed("receipt signature mismatch")
        }
    }

    private static func computeCid(hashes: Any) -> String {
        let canonical = CanonicalJSON.encode(["hashes": hashes])
        let digest = SHA256.hash(data: Data(canonical.utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return "cidv1:sha256:\(hex)"
    }
}

// MARK: - Backend selection

fileprivate enum Backend {
    case coreml(CoreMLBackend)
    case mlx(MLXBackend)
    case gguf(GGUFBackend)

    static func pick(workDir: URL, manifest: [String: Any]) throws -> Backend {
        let fm = FileManager.default
        let mlpackage = workDir.appendingPathComponent("model.mlpackage")
        if fm.fileExists(atPath: mlpackage.path) {
            return .coreml(CoreMLBackend(modelURL: mlpackage))
        }
        let mlx = workDir.appendingPathComponent("model.mlx")
        if fm.fileExists(atPath: mlx.path) {
            return .mlx(MLXBackend(modelDir: workDir))
        }
        for candidate in ["model.gguf", "model.Q4_K_M.gguf", "model.Q5_K_M.gguf"] {
            let p = workDir.appendingPathComponent(candidate)
            if fm.fileExists(atPath: p.path) {
                return .gguf(GGUFBackend(modelURL: p))
            }
        }
        throw KolmError.noRuntimeAvailable
    }

    func generate(prompt: String, maxTokens: Int) throws -> String {
        switch self {
        case .coreml(let b): return try b.generate(prompt: prompt, maxTokens: maxTokens)
        case .mlx(let b):    return try b.generate(prompt: prompt, maxTokens: maxTokens)
        case .gguf(let b):   return try b.generate(prompt: prompt, maxTokens: maxTokens)
        }
    }
}

// MARK: - Runtime stubs
//
// These exist so the SDK compiles on every Apple platform and the call shape
// is fixed. Real model execution requires either CoreML auto-generated
// classes (Xcode generates a CoreML class from `model.mlpackage` at build
// time) or a vendored MLX / llama.cpp module. Users wire those in once and
// the rest of the SDK does not change.

fileprivate struct CoreMLBackend {
    let modelURL: URL
    func generate(prompt: String, maxTokens: Int) throws -> String {
        throw KolmError.runtimeFailure(
            "CoreML model class not generated. Add \(modelURL.lastPathComponent) to the Xcode target so Xcode emits the model class, then call its `.prediction(text:)` method from a thin wrapper."
        )
    }
}

fileprivate struct MLXBackend {
    let modelDir: URL
    func generate(prompt: String, maxTokens: Int) throws -> String {
        throw KolmError.runtimeFailure(
            "MLX backend requires the mlx-swift package. Add https://github.com/ml-explore/mlx-swift and call MLXLM.generate(model: modelDir, prompt:) from a thin wrapper."
        )
    }
}

fileprivate struct GGUFBackend {
    let modelURL: URL
    func generate(prompt: String, maxTokens: Int) throws -> String {
        throw KolmError.runtimeFailure(
            "GGUF backend requires llama.cpp. Add the ggerganov/llama.cpp xcframework and call llama_decode from a thin wrapper. Model: \(modelURL.lastPathComponent)"
        )
    }
}

// MARK: - Helpers

fileprivate enum CanonicalJSON {
    static func encode(_ value: Any) -> String {
        if let dict = value as? [String: Any] {
            let keys = dict.keys.sorted()
            let items = keys.map { k -> String in
                let kStr = "\"\(escape(k))\""
                return "\(kStr):\(encode(dict[k] ?? NSNull()))"
            }
            return "{" + items.joined(separator: ",") + "}"
        }
        if let arr = value as? [Any] {
            return "[" + arr.map { encode($0) }.joined(separator: ",") + "]"
        }
        if let s = value as? String { return "\"\(escape(s))\"" }
        if value is NSNull { return "null" }
        if let b = value as? Bool { return b ? "true" : "false" }
        if let n = value as? NSNumber {
            // NSNumber covers Int / Double on Apple platforms
            if CFNumberIsFloatType(n) { return String(describing: n.doubleValue) }
            return String(describing: n.intValue)
        }
        return "null"
    }

    private static func escape(_ s: String) -> String {
        var out = ""
        for ch in s {
            switch ch {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:   out.append(ch)
            }
        }
        return out
    }
}

fileprivate enum Unzip {
    static func expand(zipURL: URL, to dest: URL) throws {
        // Apple platforms ship libcompression; .kolm is a flat zip so we use
        // Foundation's FileManager + Process where allowed (macOS), otherwise
        // we expect callers to vendor a small unzip (ZIPFoundation).
        #if os(macOS)
        let task = Process()
        task.launchPath = "/usr/bin/ditto"
        task.arguments = ["-xk", zipURL.path, dest.path]
        try task.run()
        task.waitUntilExit()
        if task.terminationStatus != 0 {
            throw KolmError.runtimeFailure("unzip failed (\(task.terminationStatus))")
        }
        #else
        // iOS/iPadOS/tvOS/watchOS — point users at ZIPFoundation.
        throw KolmError.runtimeFailure(
            "Add the ZIPFoundation SwiftPM dependency on iOS/tvOS/watchOS to unpack .kolm artifacts. macOS is unzipped via /usr/bin/ditto."
        )
        #endif
    }
}
