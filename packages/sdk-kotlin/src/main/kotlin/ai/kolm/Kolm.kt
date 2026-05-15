package ai.kolm

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.zip.ZipInputStream
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Kolm — one-line embed for .kolm artifacts on Android.
 *
 *     val model = Kolm.load(context, assetName = "phi-redactor.kolm")
 *     val out = model.predict("text")
 *     // out.text, out.cid, out.credential
 */
object Kolm {

    enum class Verify { OFF, ON, STRICT }

    class Configuration {
        @JvmField var verify: Verify = Verify.ON
        @JvmField var secret: ByteArray? = null
    }

    val config = Configuration()

    data class Output(
        val text: String,
        val cid: String?,
        val credential: String?,
        val latencyMs: Long
    )

    class KolmException(message: String) : RuntimeException(message)

    fun load(context: Context, assetName: String): Model {
        val workDir = File(context.cacheDir, "kolm-${UUID.randomUUID()}").apply { mkdirs() }
        context.assets.open(assetName).use { input ->
            ZipInputStream(input).use { zis ->
                var entry = zis.nextEntry
                while (entry != null) {
                    if (!entry.isDirectory) {
                        val out = File(workDir, entry.name).apply { parentFile?.mkdirs() }
                        out.outputStream().use { zis.copyTo(it) }
                    }
                    zis.closeEntry()
                    entry = zis.nextEntry
                }
            }
        }
        return openWorkDir(workDir)
    }

    fun load(file: File): Model {
        val workDir = File(file.parentFile, "kolm-${UUID.randomUUID()}").apply { mkdirs() }
        file.inputStream().use { input ->
            ZipInputStream(input).use { zis ->
                var entry = zis.nextEntry
                while (entry != null) {
                    if (!entry.isDirectory) {
                        val out = File(workDir, entry.name).apply { parentFile?.mkdirs() }
                        out.outputStream().use { zis.copyTo(it) }
                    }
                    zis.closeEntry()
                    entry = zis.nextEntry
                }
            }
        }
        return openWorkDir(workDir)
    }

    // -- internals ---------------------------------------------------------

    private fun openWorkDir(workDir: File): Model {
        val manifestFile = File(workDir, "manifest.json")
        if (!manifestFile.exists()) throw KolmException("missing manifest.json")
        val manifest = JSONObject(manifestFile.readText(Charsets.UTF_8))

        if (config.verify != Verify.OFF && manifest.has("cid") && manifest.has("hashes")) {
            val expected = computeCid(manifest.get("hashes"))
            val actual = manifest.getString("cid")
            if (actual != expected) {
                throw KolmException("manifest CID $actual != $expected")
            }
        }

        val receiptFile = File(workDir, "receipt.json")
        if (receiptFile.exists()) {
            val receipt = JSONObject(receiptFile.readText(Charsets.UTF_8))
            verifyReceipt(receipt)
        } else if (config.verify == Verify.STRICT) {
            throw KolmException("strict verify: receipt.json missing")
        }

        val credentialFile = File(workDir, "credential.json")
        val credential = if (credentialFile.exists()) {
            try { JSONObject(credentialFile.readText(Charsets.UTF_8)) } catch (_: Exception) { null }
        } else null

        val backend = Backend.pick(workDir)
        return Model(workDir, manifest, credential, backend)
    }

    private fun verifyReceipt(receipt: JSONObject) {
        if (config.verify == Verify.OFF) return
        val sig = receipt.optString("signature", "")
        if (sig.isEmpty()) {
            if (config.verify == Verify.STRICT) throw KolmException("receipt has no signature")
            return
        }
        val secret = config.secret
        if (secret == null) {
            if (config.verify == Verify.STRICT) {
                throw KolmException("strict verify requires Kolm.config.secret")
            }
            return
        }
        val body = JSONObject(receipt.toString()).apply { remove("signature") }
        val canonical = canonicalJson(body).toByteArray(Charsets.UTF_8)
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret, "HmacSHA256"))
        val expected = mac.doFinal(canonical).joinToString("") { "%02x".format(it) }
        if (expected != sig) throw KolmException("receipt signature mismatch")
    }

    private fun computeCid(hashes: Any): String {
        val body = JSONObject().apply { put("hashes", hashes) }
        val canonical = canonicalJson(body).toByteArray(Charsets.UTF_8)
        val digest = MessageDigest.getInstance("SHA-256").digest(canonical)
        val hex = digest.joinToString("") { "%02x".format(it) }
        return "cidv1:sha256:$hex"
    }

    /** Canonical JSON: sorted keys, no whitespace, recursive. */
    private fun canonicalJson(value: Any?): String = when (value) {
        null -> "null"
        is JSONObject -> {
            val keys = value.keys().asSequence().toMutableList().apply { sort() }
            keys.joinToString(",", "{", "}") { k ->
                "\"" + escape(k) + "\":" + canonicalJson(value.get(k))
            }
        }
        is JSONArray -> {
            (0 until value.length()).joinToString(",", "[", "]") {
                canonicalJson(value.get(it))
            }
        }
        is String -> "\"" + escape(value) + "\""
        is Boolean -> if (value) "true" else "false"
        is Number -> value.toString()
        else -> "\"" + escape(value.toString()) + "\""
    }

    private fun escape(s: String): String = buildString {
        for (c in s) when (c) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> append(c)
        }
    }

    // -- Model -------------------------------------------------------------

    class Model internal constructor(
        private val workDir: File,
        private val manifest: JSONObject,
        private val credential: JSONObject?,
        private val backend: Backend,
    ) {
        val cid: String? get() = if (manifest.has("cid")) manifest.getString("cid") else null
        val task: String? get() = if (manifest.has("task")) manifest.getString("task") else null
        val baseModel: String? get() = if (manifest.has("base_model")) manifest.getString("base_model") else null

        @JvmOverloads
        fun predict(text: String, maxTokens: Int = 256): Output {
            val start = System.currentTimeMillis()
            val ans = backend.generate(text, maxTokens)
            return Output(
                text = ans,
                cid = cid,
                credential = credential?.optString("credential_id"),
                latencyMs = System.currentTimeMillis() - start
            )
        }
    }
}

/**
 * Backend interface — Kotlin pickers wire ExecuTorch/llama.cpp/ONNX at the
 * consumer module. Stubs throw a crisp message naming the missing dep.
 */
internal sealed class Backend {
    abstract fun generate(prompt: String, maxTokens: Int): String

    companion object {
        fun pick(workDir: File): Backend {
            File(workDir, "model.gguf").takeIf { it.exists() }?.let {
                return Llama(it)
            }
            File(workDir, "model.pte").takeIf { it.exists() }?.let {
                return ExecuTorch(it)
            }
            File(workDir, "model.onnx").takeIf { it.exists() }?.let {
                return Onnx(it)
            }
            throw Kolm.KolmException("no compatible model file in artifact (need model.gguf | model.pte | model.onnx)")
        }
    }

    class Llama(val model: File) : Backend() {
        override fun generate(prompt: String, maxTokens: Int): String =
            throw Kolm.KolmException(
                "llama.cpp backend selected (${model.name}). Add a llama.cpp Android AAR to your app and wire its `decode(prompt, maxTokens)` into Backend.Llama. Stub returned no output."
            )
    }

    class ExecuTorch(val model: File) : Backend() {
        override fun generate(prompt: String, maxTokens: Int): String =
            throw Kolm.KolmException(
                "ExecuTorch backend selected (${model.name}). Add com.facebook.executorch:executorch-android and wire org.pytorch.executorch.Module.load(...).forward(...) into Backend.ExecuTorch. Stub returned no output."
            )
    }

    class Onnx(val model: File) : Backend() {
        override fun generate(prompt: String, maxTokens: Int): String =
            throw Kolm.KolmException(
                "ONNX Runtime backend selected (${model.name}). Add com.microsoft.onnxruntime:onnxruntime-android and wire OrtSession + greedy decode into Backend.Onnx. Stub returned no output."
            )
    }
}
