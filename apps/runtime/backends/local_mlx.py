"""
apps/runtime/backends/local_mlx.py

Apple Silicon native via MLX (mlx.core / mlx-lm). Faster than MPS for inference
on M-series because MLX uses unified memory + Metal compute directly. Required
for users who want top tokens/sec on M3/M4 without a CUDA box.

Detection: `import mlx.core` succeeds. We don't probe for chips here because
MLX itself only ships on Apple Silicon.

Quote: MLX runs ~1.4x faster than MPS for the same chip on typical 7B INT8
workloads. We multiply MPS estimates by 1.4.

Run: dispatches via mlx_lm.generate. The artifact is staged to disk for MLX
to read its safetensors directly.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Dict

from .base import BackendAdapter, BackendInfo, Detection, Quote
from .local_cpu import _params_billion_from_artifact, _fallback_response
from .local_mps import _detect_apple_chip, _tps_for_chip


class LocalMLXBackend(BackendAdapter):
    info = BackendInfo(
        name="local-mlx",
        family="local",
        description="Apple Silicon native via MLX. Fastest on M-series.",
        requires_env=[],
        requires_pip=["mlx", "mlx-lm"],
        docs_url="/compute#local-mlx",
    )

    def detect(self) -> Detection:
        try:
            import mlx.core as mx
        except ImportError:
            return Detection(available=False, reason="mlx not installed (pip install mlx mlx-lm)")
        try:
            _ = mx.array([1.0])
        except Exception as e:
            return Detection(available=False, reason=f"mlx broken: {e}")
        return Detection(
            available=True,
            reason="MLX available",
            device_name=_detect_apple_chip() or "Apple Silicon",
        )

    def quote(self, artifact: Path, tokens: int = 1024) -> Quote:
        params_b = _params_billion_from_artifact(artifact)
        base = _tps_for_chip()
        tps = base * 1.4
        scaled = tps * (7.0 / max(params_b, 1.0))
        wall = tokens / max(scaled, 40.0)
        return Quote(
            price_usd=0.0,
            wall_seconds=wall,
            cold_start_seconds=4.0,
            notes=f"~{scaled:.0f} tok/s ({params_b:.1f}B params, MLX)",
        )

    def run(self, artifact: Path, request: Dict[str, Any]) -> Dict[str, Any]:
        t0 = time.time()
        try:
            response = _mlx_generate(artifact, request)
        except Exception:
            response = _fallback_response(request, backend="local-mlx")
        response.setdefault("kolm_compute", {})
        response["kolm_compute"].update({
            "backend": "local-mlx",
            "wall_seconds": time.time() - t0,
            "price_usd": 0.0,
        })
        return response


def _mlx_generate(artifact: Path, request: Dict[str, Any]) -> Dict[str, Any]:
    """Stage the artifact's model files to disk and call mlx_lm.generate."""
    import json
    import tempfile
    import zipfile

    from mlx_lm import generate, load

    messages = request.get("messages", [])
    prompt = "\n".join(m.get("content", "") for m in messages if isinstance(m, dict))
    max_tokens = int(request.get("max_tokens", 256))

    with tempfile.TemporaryDirectory() as tmp:
        with zipfile.ZipFile(artifact) as zf:
            zf.extractall(tmp)
        model, tokenizer = load(tmp)
        text = generate(model, tokenizer, prompt=prompt, max_tokens=max_tokens, verbose=False)

    return {
        "id": "kolm-mlx",
        "object": "chat.completion",
        "model": request.get("model", "unknown"),
        "choices": [
            {"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}
        ],
        "usage": {"prompt_tokens": len(prompt.split()), "completion_tokens": len(text.split()), "total_tokens": 0},
    }
