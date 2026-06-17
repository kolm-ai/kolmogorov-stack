package ai.kolm

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.zip.ZipInputStream
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Kolm - one-line embed for .kolm artifacts on Android.
 *
 *     val model = Kolm.load(context, assetName = "phi-redactor.kolm")
 *     val out = model.predict("text")
 *     // out.text, out.cid, out.credential
 */
object Kolm {
    private const val MAX_ZIP_ENTRIES = 512
    private const val MAX_ZIP_ENTRY_BYTES = 2L * 1024L * 1024L * 1024L
    private const val MAX_ZIP_TOTAL_BYTES = 4L * 1024L * 1024L * 1024L
    private const val COPY_BUFFER_SIZE = 64 * 1024
    private val HEX64 = Regex("^[0-9a-f]{64}$")
    private val REQUIRED_HASH_KEYS = listOf(
        "model_pointer",
        "recipes_json",
        "lora_bin",
        "index_bin",
        "evals_json",
    )

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
        val workDir = createWorkDir(context.cacheDir)
        return try {
            context.assets.open(assetName).use { input -> extractArtifact(input, workDir) }
            openWorkDir(workDir)
        } catch (e: Exception) {
            workDir.deleteRecursively()
            throw e
        }
    }

    fun load(file: File): Model {
        val parent = file.parentFile ?: File(".")
        val workDir = createWorkDir(parent)
        return try {
            file.inputStream().use { input -> extractArtifact(input, workDir) }
            openWorkDir(workDir)
        } catch (e: Exception) {
            workDir.deleteRecursively()
            throw e
        }
    }

    // -- internals ---------------------------------------------------------

    private fun createWorkDir(parent: File): File {
        if (!parent.exists() && !parent.mkdirs()) {
            throw KolmException("could not create parent work directory")
        }
        val dir = File(parent, "kolm-${UUID.randomUUID()}")
        if (!dir.mkdirs()) throw KolmException("could not create work directory")
        return dir
    }

    private fun extractArtifact(input: InputStream, workDir: File) {
        val seen = mutableSetOf<String>()
        var entryCount = 0
        var totalBytes = 0L
        ZipInputStream(input).use { zis ->
            var entry = zis.nextEntry
            while (entry != null) {
                entryCount += 1
                if (entryCount > MAX_ZIP_ENTRIES) {
                    throw KolmException("zip entry count exceeds $MAX_ZIP_ENTRIES")
                }
                if (!entry.isDirectory) {
                    val name = normalizeZipEntryName(entry.name)
                    if (!seen.add(name)) throw KolmException("duplicate zip entry name: $name")
                    val declaredSize = entry.size
                    if (declaredSize > MAX_ZIP_ENTRY_BYTES) {
                        throw KolmException("zip entry $name exceeds per-entry size limit")
                    }
                    val copied = copyEntryBounded(
                        zis,
                        safeOutputFile(workDir, name),
                        name,
                        MAX_ZIP_TOTAL_BYTES - totalBytes
                    )
                    if (Long.MAX_VALUE - totalBytes < copied) throw KolmException("zip total size overflow")
                    totalBytes += copied
                }
                zis.closeEntry()
                entry = zis.nextEntry
            }
        }
    }

    private fun normalizeZipEntryName(name: String): String {
        val normalized = name.replace('\\', '/')
        val parts = normalized.split('/')
        if (
            normalized.isBlank() ||
            normalized.startsWith("/") ||
            normalized.contains(":") ||
            parts.any { it.isBlank() || it == "." || it == ".." }
        ) {
            throw KolmException("unsafe zip entry name: $name")
        }
        return normalized
    }

    private fun safeOutputFile(workDir: File, entryName: String): File {
        val base = workDir.canonicalFile
        val out = File(base, entryName).canonicalFile
        val basePath = base.path + File.separator
        if (out.path != base.path && !out.path.startsWith(basePath)) {
            throw KolmException("unsafe zip entry name: $entryName")
        }
        return out
    }

    private fun copyEntryBounded(input: InputStream, out: File, name: String, totalRemaining: Long): Long {
        val parent = out.parentFile ?: throw KolmException("zip entry has no parent directory: $name")
        parent.mkdirs()
        val tmp = File(parent, ".${out.name}.${UUID.randomUUID()}.tmp")
        var written = 0L
        try {
            tmp.outputStream().use { output ->
                val buffer = ByteArray(COPY_BUFFER_SIZE)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    written += read.toLong()
                    if (written > MAX_ZIP_ENTRY_BYTES) {
                        throw KolmException("zip entry $name exceeds per-entry size limit")
                    }
                    if (written > totalRemaining) {
                        throw KolmException("zip uncompressed size exceeds total limit")
                    }
                    output.write(buffer, 0, read)
                }
            }
            if (!tmp.renameTo(out)) throw KolmException("could not move extracted zip entry: $name")
            return written
        } catch (e: Exception) {
            tmp.delete()
            throw e
        }
    }

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
            if (config.verify != Verify.OFF && manifest.has("cid")) {
                val receiptCid = receipt.optString("cid", "")
                if (receiptCid.isNotEmpty() && receiptCid != manifest.getString("cid")) {
                    throw KolmException("receipt CID $receiptCid != ${manifest.getString("cid")}")
                }
            }
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
        if (!constantTimeEquals(expected, sig)) throw KolmException("receipt signature mismatch")
    }

    private fun computeCid(hashes: Any): String {
        if (hashes !is JSONObject) throw KolmException("manifest hashes must be an object")
        val parts = JSONObject()
        for (key in REQUIRED_HASH_KEYS) {
            val value = hashes.optString(key, "")
            if (!HEX64.matches(value)) {
                throw KolmException("manifest hashes.$key must be a 64-char lowercase sha256")
            }
            parts.put(key, value)
        }
        val body = JSONObject().apply {
            put("digest", "sha256")
            put("parts", parts)
        }
        val canonical = canonicalJson(body).toByteArray(Charsets.UTF_8)
        val digest = MessageDigest.getInstance("SHA-256").digest(canonical)
        val hex = digest.joinToString("") { "%02x".format(it) }
        return "cidv1:sha256:$hex"
    }

    private fun constantTimeEquals(a: String, b: String): Boolean {
        val left = a.toByteArray(Charsets.US_ASCII)
        val right = b.toByteArray(Charsets.US_ASCII)
        if (left.size != right.size) return false
        var diff = 0
        for (i in left.indices) diff = diff or (left[i].toInt() xor right[i].toInt())
        return diff == 0
    }

    /** Canonical JSON: sorted keys, no whitespace, recursive. */
    private fun canonicalJson(value: Any?): String = when (value) {
        null -> "null"
        JSONObject.NULL -> "null"
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
 * Backend interface. Kotlin pickers wire ExecuTorch/llama.cpp/ONNX at the
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
