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

__all__ = ["EXPORTERS", "get_exporter", "ExportError", "ExportNotApplicable", "doctor"]


def doctor() -> dict:
    """Probe each export backend's toolchain. Never raises.

    Reports per-backend whether the required python imports succeed and
    whether the required executables are on PATH. Returns a hint string a
    user can paste to install a missing backend.
    """
    import importlib
    import shutil

    PROBES = {
        "gguf": {
            "py": ["transformers", "peft", "safetensors"],
            "bin": ["convert-hf-to-gguf.py", "llama-quantize"],
            "hint": "pip install transformers peft safetensors gguf  &&  git clone https://github.com/ggerganov/llama.cpp",
            "any_bin": True,
        },
        "mlx": {
            "py": ["mlx", "mlx_lm"],
            "bin": [],
            "hint": "pip install mlx mlx-lm   (Apple Silicon only)",
        },
        "onnx": {
            "py": ["onnx", "transformers"],
            "bin": [],
            "hint": "pip install onnx onnxruntime transformers optimum",
        },
        "coreml": {
            "py": ["coremltools", "transformers"],
            "bin": [],
            "hint": "pip install coremltools transformers   (macOS only for full export)",
        },
        "tensorrt": {
            "py": ["tensorrt_llm"],
            "bin": ["trtllm-build"],
            "hint": "see https://nvidia.github.io/TensorRT-LLM/installation/   (CUDA + NVIDIA GPU required)",
        },
        "executorch": {
            "py": ["executorch"],
            "bin": [],
            "hint": "pip install executorch   (or build from source for mobile targets)",
        },
    }

    results = {}
    for backend, p in PROBES.items():
        missing_py = []
        for mod in p["py"]:
            try:
                importlib.import_module(mod)
            except Exception:
                missing_py.append(mod)
        missing_bin = []
        for b in p["bin"]:
            if shutil.which(b) is None:
                missing_bin.append(b)
        any_bin = p.get("any_bin", False)
        bin_ok = (not p["bin"]) or (any_bin and len(missing_bin) < len(p["bin"])) or (not any_bin and not missing_bin)
        ready = (not missing_py) and bin_ok
        results[backend] = {
            "ready": ready,
            "missing_python": missing_py,
            "missing_binaries": missing_bin,
            "hint": p["hint"] if not ready else None,
        }
    return {
        "backends": results,
        "ready_count": sum(1 for r in results.values() if r["ready"]),
        "total": len(results),
    }
