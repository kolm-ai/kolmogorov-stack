"""
apps/runtime/backends/local_cpu.py

CPU backend. Always available as a fallback; slow but deterministic. Suitable
for small artifacts (<1B parameters), structured-output use cases, and CI.

Detection: succeeds unconditionally. We use the platform module to record the
machine name so the receipt reflects what actually ran. No GPU probing.

Quote: estimate based on a 12 tok/s floor for a typical 7B INT8 on modern x86.
For smaller models we scale linearly with the parameter count from the manifest.

Run: dispatches to apps.runtime.serve.run_locally with device='cpu'. The serve
module already handles transformers fallback when vLLM isn't present.
"""

from __future__ import annotations

import platform
import time
from pathlib import Path
from typing import Any, Dict

from .base import BackendAdapter, BackendInfo, Detection, Quote


class LocalCPUBackend(BackendAdapter):
    info = BackendInfo(
        name="local-cpu",
        family="local",
        description="CPU on this machine. Always available; slow for big models.",
        requires_env=[],
        requires_pip=["transformers"],
        docs_url="/compute#local-cpu",
    )

    def detect(self) -> Detection:
        return Detection(
            available=True,
            reason="CPU is always available",
            device_name=f"{platform.processor() or platform.machine()} / {platform.system()}",
        )

    def quote(self, artifact: Path, tokens: int = 1024) -> Quote:
        params_b = _params_billion_from_artifact(artifact)
        tps = max(2.0, 12.0 / max(params_b, 0.5))
        wall = tokens / tps
        return Quote(
            price_usd=0.0,
            wall_seconds=wall,
            cold_start_seconds=4.0,
            notes=f"~{tps:.1f} tok/s on CPU ({params_b:.1f}B params)",
        )

    def run(self, artifact: Path, request: Dict[str, Any]) -> Dict[str, Any]:
        from apps.runtime import serve

        t0 = time.time()
        try:
            response = serve.run_request(artifact=str(artifact), request=request, device="cpu")
        except AttributeError:
            response = _fallback_response(request, backend="local-cpu")
        response.setdefault("kolm_compute", {})
        response["kolm_compute"].update({
            "backend": "local-cpu",
            "wall_seconds": time.time() - t0,
            "price_usd": 0.0,
        })
        return response


def _params_billion_from_artifact(artifact: Path) -> float:
    """Sniff parameter count from manifest. Defaults to 7B if absent."""
    import json
    import zipfile

    try:
        with zipfile.ZipFile(artifact) as zf:
            with zf.open("manifest.json") as f:
                manifest = json.load(f)
        params = manifest.get("model", {}).get("params_billion")
        if isinstance(params, (int, float)):
            return float(params)
    except Exception:
        pass
    return 7.0


def _fallback_response(request: Dict[str, Any], backend: str) -> Dict[str, Any]:
    """Used when serve.run_request isn't yet wired. Emits a minimal OpenAI shape."""
    return {
        "id": "kolm-fallback",
        "object": "chat.completion",
        "model": request.get("model", "unknown"),
        "choices": [
            {"index": 0, "message": {"role": "assistant", "content": ""}, "finish_reason": "stop"}
        ],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        "kolm_compute": {"backend": backend, "note": "serve.run_request not yet wired"},
    }
