"""kolm native-format importers (W740).

The symmetric counterpart to apps.export. Where apps.export takes a compiled
.kolm artifact and emits a runtime-native binary (gguf/onnx/safetensors/coreml/
mlx/tensorrt), apps.import takes a runtime-native binary and emits the
HEADERS-ONLY metadata that lets kolm wrap it as a `not_kolm_compiled` manifest.

Honesty contract
----------------
Imports are wrapped with `not_kolm_compiled: true` in the resulting manifest.
The model file itself is never modified, never silently re-tagged as a
kolm-compiled artifact, and never gains a K-Score until it actually passes
through `kolm distill` again. The wrap path is read-only metadata: source
sha256, source path, declared format, declared parameter count.

Each format module exposes a CLI entry point:

    python3 apps/import/gguf.py        <file>
    python3 apps/import/safetensors.py <file>
    python3 apps/import/onnx.py        <file>

Emits a single JSON envelope on stdout:

    { ok: true,
      format: "gguf" | "safetensors" | "onnx",
      params_b: <float|null>,
      quant: <str|null>,
      source_path: <str>,
      sha256: <hex>,
      raw_metadata_keys: [<str>, ...] }

On parse failure:

    { ok: false, error: "<format>_parse_failed", hint: "..." }   (exit 3)

stdlib ONLY — no third-party deps. Heavier parsers (gguf 1.0+ tensor walking,
safetensors weight loading, onnx protobuf deep-walk) are out of scope; we
parse just enough of the header to identify the format honestly.
"""
