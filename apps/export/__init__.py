"""kolm native-backend exporters.

Convert a compiled .kolm artifact (LoRA tier and above) into runtime-native
formats so it runs on the toolchain a customer already has:

    gguf       llama.cpp / Ollama / LM Studio
    mlx        Apple Silicon (mlx_lm)
    executorch iOS / Android on-device PyTorch
    tensorrt   NVIDIA serving (TensorRT-LLM)
    coreml     iOS via Core ML Tools
    onnx       ONNX Runtime (Windows, CPU edge)

Each backend exposes a `plan(artifact)` that returns the conversion shape
(intermediate steps, expected outputs) and an `export(artifact, out_dir)`
that actually runs the toolchain. If the toolchain isn't present, `export`
raises with a crisp install hint — never silently fakes a file.

Recipe-tier artifacts (v0.1 default) have nothing to convert; the planner
returns a 'recipe-only' shape and `export` raises ExportNotApplicable.
"""

from .registry import EXPORTERS, get_exporter, ExportError, ExportNotApplicable

__all__ = ["EXPORTERS", "get_exporter", "ExportError", "ExportNotApplicable"]
