# kolm-android (Kotlin)

Embed a `.kolm` artifact in Android apps.

```kotlin
import ai.kolm.Kolm

val model = Kolm.load(context, assetName = "phi-redactor.kolm")
val out = model.predict("Patient John Doe, MRN 8847-21.")
println(out.text)  // "Patient [NAME], MRN [ID]."
```

## Install (Gradle)

```kotlin
dependencies {
    implementation("ai.kolm:kolm:0.2.6")
}
```

## Backends

| Trigger                                            | Backend           |
| -------------------------------------------------- | ----------------- |
| `model.gguf` in artifact + `llama.cpp` AAR present | llama.cpp         |
| `model.pte` in artifact + ExecuTorch present       | ExecuTorch (PyTorch Edge) |
| `model.onnx` in artifact + onnxruntime-android      | ONNX Runtime      |

Use `kolm export --backend gguf|executorch|onnx` on the desktop to produce
the right file. Adding ExecuTorch or llama.cpp to your Android project is
a one-time step (vendored AAR or Gradle dep) — the kolm-android wrapper
just dispatches.

## Receipt verification

`Kolm.load` checks the artifact CID against `manifest.hashes`. Body
signature verification is opt-in:

```kotlin
Kolm.config.secret = "...".toByteArray()
Kolm.config.verify = Kolm.Verify.STRICT
val model = Kolm.load(context, assetName = "phi-redactor.kolm")
```

## License

Apache-2.0
