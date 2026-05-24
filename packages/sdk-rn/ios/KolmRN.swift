import Foundation
import React

@objc(KolmRN)
final class KolmRN: NSObject {
    private var handles: [String: URL] = [:]

    @objc(load:options:resolver:rejecter:)
    func load(
        localPath: String,
        options: NSDictionary,
        resolve: RCTPromiseResolveBlock,
        reject: RCTPromiseRejectBlock
    ) {
        let url = URL(fileURLWithPath: localPath)
        guard FileManager.default.fileExists(atPath: url.path) else {
            reject("ENOENT", "Kolm artifact not found at \(localPath)", nil)
            return
        }
        let handle = UUID().uuidString
        handles[handle] = url
        resolve([
            "handle": handle,
            "cid": NSNull(),
            "task": NSNull(),
            "base_model": NSNull(),
        ])
    }

    @objc(predict:text:maxTokens:resolver:rejecter:)
    func predict(
        handle: String,
        text: String,
        maxTokens: NSNumber,
        resolve: RCTPromiseResolveBlock,
        reject: RCTPromiseRejectBlock
    ) {
        guard handles[handle] != nil else {
            reject("ENOENT", "Unknown Kolm handle \(handle)", nil)
            return
        }
        reject(
            "E_RUNTIME_UNAVAILABLE",
            "Native Kolm runtime is not linked. Add the Kolm Swift SDK backend for Core ML, MLX, or GGUF, then forward this handle to that runtime.",
            nil
        )
    }

    @objc(dispose:resolver:rejecter:)
    func dispose(handle: String, resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        handles.removeValue(forKey: handle)
        resolve(nil)
    }

    @objc
    static func requiresMainQueueSetup() -> Bool {
        false
    }
}
