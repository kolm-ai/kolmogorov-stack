package ai.kolm.rn

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import java.io.File
import java.util.UUID

class KolmRNModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {
    private val handles = mutableMapOf<String, File>()

    override fun getName(): String = "KolmRN"

    @ReactMethod
    fun load(localPath: String, options: ReadableMap, promise: Promise) {
        val file = File(localPath)
        if (!file.exists()) {
            promise.reject("ENOENT", "Kolm artifact not found at $localPath")
            return
        }
        val handle = UUID.randomUUID().toString()
        handles[handle] = file
        val result = Arguments.createMap()
        result.putString("handle", handle)
        result.putNull("cid")
        result.putNull("task")
        result.putNull("base_model")
        promise.resolve(result)
    }

    @ReactMethod
    fun predict(handle: String, text: String, maxTokens: Int, promise: Promise) {
        if (!handles.containsKey(handle)) {
            promise.reject("ENOENT", "Unknown Kolm handle $handle")
            return
        }
        promise.reject(
            "E_RUNTIME_UNAVAILABLE",
            "Native Kolm runtime is not linked. Add the Kolm Android SDK backend for ExecuTorch, ONNX, or GGUF, then forward this handle to that runtime."
        )
    }

    @ReactMethod
    fun dispose(handle: String, promise: Promise) {
        handles.remove(handle)
        promise.resolve(null)
    }
}
