// Kolm.swift - one-line embed for .kolm artifacts on Apple platforms.
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
    case invalidInput(String)
    case verificationFailed(String)
    case noRuntimeAvailable
    case runtimeFailure(String)

    public var description: String {
        switch self {
        case .missingArtifact(let n): return "missing artifact: \(n)"
        case .missingManifest:        return "manifest.json missing in artifact"
        case .missingReceipt:         return "receipt.json missing in artifact"
        case .invalidInput(let r):     return "invalid input: \(r)"
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

public enum KolmLimits {
    public static let defaultMaxTokens = 256
    public static let maxTokens = 32768
}

fileprivate let DEFAULT_MAX_TOKENS = KolmLimits.defaultMaxTokens
fileprivate let MAX_TOKENS = KolmLimits.maxTokens
fileprivate let MAX_ARTIFACT_FILES = 8192
fileprivate let MAX_ARTIFACT_BYTES: UInt64 = 8 * 1024 * 1024 * 1024

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

    public func predict(_ text: String, maxTokens: Int = KolmLimits.defaultMaxTokens) throws -> KolmOutput {
        let safeMaxTokens = try normalizeMaxTokens(maxTokens)
        let start = Date()
        let out = try backend.generate(prompt: text, maxTokens: safeMaxTokens)
        return KolmOutput(
            text: out,
            cid: cid,
            credential: credentialId,
            latencyMs: Date().timeIntervalSince(start) * 1000
        )
    }
}

public enum Kolm {
    public typealias Configuration = KolmConfiguration

    /// Load by file name from the main bundle.
    public static func load(named name: String, bundle: Bundle = .main) throws -> KolmModel {
        guard isSafeBundleArtifactName(name) else {
            throw KolmError.invalidInput("artifact name must be a non-empty bundle resource name")
        }
        let stem = name.hasSuffix(".kolm") ? String(name.dropLast(5)) : name
        guard let url = bundle.url(forResource: stem, withExtension: "kolm") else {
            throw KolmError.missingArtifact(name)
        }
        return try load(at: url)
    }

    /// Load from a local artifact URL.
    public static func load(at url: URL) throws -> KolmModel {
        let fm = FileManager.default
        let artifactURL = try ArtifactSafety.validateLocalArtifactURL(url)
        let work = fm.temporaryDirectory.appendingPathComponent("kolm-\(UUID().uuidString)")
        try fm.createDirectory(at: work, withIntermediateDirectories: true)
        try Unzip.expand(zipURL: artifactURL, to: work)
        try ArtifactSafety.validateExtractedTree(root: work)

        let manifestURL = work.appendingPathComponent("manifest.json")
        let manifest = try ArtifactSafety.readJSONObject(manifestURL, missing: .missingManifest, label: "manifest.json")

        try verifyManifest(manifest: manifest)

        let receiptURL = work.appendingPathComponent("receipt.json")
        if fm.fileExists(atPath: receiptURL.path) {
            let receipt = try ArtifactSafety.readJSONObject(receiptURL, missing: .missingReceipt, label: "receipt.json")
            try verifyReceipt(receipt: receipt, manifest: manifest)
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

    private static func verifyManifest(manifest: [String: Any]) throws {
        guard KolmConfiguration.shared.verify != .off else { return }

        guard let cid = manifest["cid"] as? String, !cid.isEmpty else {
            if KolmConfiguration.shared.verify == .strict {
                throw KolmError.verificationFailed("manifest cid is required in strict mode")
            }
            return
        }
        guard isValidCid(cid) else {
            throw KolmError.verificationFailed("manifest cid has invalid format")
        }
        guard let hashes = manifest["hashes"] as? [String: Any] else {
            throw KolmError.verificationFailed("manifest hashes are required when cid is present")
        }

        let expected = computeCid(hashes: hashes)
        if cid != expected {
            throw KolmError.verificationFailed("manifest CID \(cid) != \(expected)")
        }
    }

    private static func verifyReceipt(receipt: [String: Any], manifest: [String: Any]) throws {
        guard KolmConfiguration.shared.verify != .off else { return }
        if let receiptCid = receipt["manifest_cid"] as? String {
            guard let manifestCid = manifest["cid"] as? String else {
                throw KolmError.verificationFailed("receipt manifest_cid present but manifest has no cid")
            }
            if receiptCid != manifestCid {
                throw KolmError.verificationFailed("receipt manifest_cid mismatch")
            }
        }
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
        guard !secret.isEmpty else {
            throw KolmError.verificationFailed("receipt secret must not be empty")
        }
        guard let signatureBytes = hexToData(signature) else {
            throw KolmError.verificationFailed("receipt signature must be 64 hex characters")
        }
        var body = receipt
        for key in ["signature", "signature_ed25519", "signature_sigstore"] {
            body.removeValue(forKey: key)
        }
        let canonical = CanonicalJSON.encode(body)
        let key = SymmetricKey(data: secret)
        if !HMAC<SHA256>.isValidAuthenticationCode(signatureBytes, authenticating: Data(canonical.utf8), using: key) {
            throw KolmError.verificationFailed("receipt signature mismatch")
        }
    }

    private static func computeCid(hashes: Any) -> String {
        let canonical = CanonicalJSON.encode(["hashes": hashes])
        let digest = SHA256.hash(data: Data(canonical.utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return "cidv1:sha256:\(hex)"
    }

    private static func isValidCid(_ cid: String) -> Bool {
        let prefix = "cidv1:sha256:"
        guard cid.hasPrefix(prefix) else { return false }
        let hex = String(cid.dropFirst(prefix.count))
        return hex.count == 64 && hex.allSatisfy { "0123456789abcdef".contains($0) }
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

fileprivate func normalizeMaxTokens(_ value: Int) throws -> Int {
    guard value >= 1 && value <= MAX_TOKENS else {
        throw KolmError.invalidInput("maxTokens must be between 1 and \(MAX_TOKENS)")
    }
    return value
}

fileprivate func isSafeBundleArtifactName(_ name: String) -> Bool {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, !trimmed.contains("\0") else { return false }
    guard !trimmed.contains("/"), !trimmed.contains("\\") else { return false }
    if trimmed == ".kolm" { return false }
    return true
}

fileprivate enum ArtifactSafety {
    static func validateLocalArtifactURL(_ url: URL) throws -> URL {
        guard url.isFileURL else {
            throw KolmError.invalidInput("artifact URL must be a local file URL")
        }
        let local = url.standardizedFileURL
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: local.path, isDirectory: &isDirectory), !isDirectory.boolValue else {
            throw KolmError.missingArtifact(local.path)
        }
        let values = try local.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])
        if values.isSymbolicLink == true || values.isRegularFile == false {
            throw KolmError.invalidInput("artifact URL must point to a regular .kolm file")
        }
        return local
    }

    static func validateExtractedTree(root: URL) throws {
        let fm = FileManager.default
        let rootURL = root.resolvingSymlinksInPath().standardizedFileURL
        let rootPath = rootURL.path
        let rootPrefix = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
        guard let enumerator = fm.enumerator(
            at: root,
            includingPropertiesForKeys: [.isSymbolicLinkKey, .isRegularFileKey, .fileSizeKey],
            options: []
        ) else {
            throw KolmError.verificationFailed("artifact extraction tree is not readable")
        }

        var fileCount = 0
        var totalBytes: UInt64 = 0
        for case let itemURL as URL in enumerator {
            fileCount += 1
            if fileCount > MAX_ARTIFACT_FILES {
                throw KolmError.verificationFailed("artifact contains too many files")
            }
            let values = try itemURL.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey, .fileSizeKey])
            if values.isSymbolicLink == true {
                throw KolmError.verificationFailed("artifact contains a symbolic link")
            }
            let resolved = itemURL.resolvingSymlinksInPath().standardizedFileURL.path
            if resolved != rootPath && !resolved.hasPrefix(rootPrefix) {
                throw KolmError.verificationFailed("artifact entry escapes extraction directory")
            }
            if values.isRegularFile == true {
                totalBytes += UInt64(max(values.fileSize ?? 0, 0))
                if totalBytes > MAX_ARTIFACT_BYTES {
                    throw KolmError.verificationFailed("artifact extracted content is too large")
                }
            }
        }
    }

    static func readJSONObject(_ url: URL, missing: KolmError, label: String) throws -> [String: Any] {
        guard FileManager.default.fileExists(atPath: url.path) else { throw missing }
        let values = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])
        if values.isSymbolicLink == true || values.isRegularFile == false {
            throw KolmError.verificationFailed("\(label) must be a regular file")
        }
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw KolmError.verificationFailed("\(label) is not a JSON object")
        }
        return object
    }
}

fileprivate func hexToData(_ hex: String) -> Data? {
    guard hex.count == 64 else { return nil }
    guard hex.allSatisfy({ "0123456789abcdefABCDEF".contains($0) }) else { return nil }
    var data = Data()
    data.reserveCapacity(hex.count / 2)
    var index = hex.startIndex
    while index < hex.endIndex {
        let next = hex.index(index, offsetBy: 2)
        guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
        data.append(byte)
        index = next
    }
    return data
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
        // iOS/iPadOS/tvOS/watchOS: point users at ZIPFoundation.
        throw KolmError.runtimeFailure(
            "Add the ZIPFoundation SwiftPM dependency on iOS/tvOS/watchOS to unpack .kolm artifacts. macOS is unzipped via /usr/bin/ditto."
        )
        #endif
    }
}
