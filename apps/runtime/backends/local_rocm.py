"""
apps/runtime/backends/local_rocm.py

AMD ROCm backend. AMD's CUDA-equivalent stack. Used on MI300X, MI250X,
Radeon RX 7900 XTX. Same OpenAI-compatible serve path as CUDA.

Detection: torch.cuda.is_available() (yes, AMD reuses the torch.cuda API
through ROCm/HIP) plus a hipBLAS or ROCm name in the device string.

Quote: MI300X ~ 3200 tok/s on 7B INT8 (close to H100), MI250X ~ 1800,
RX 7900 XTX ~ 900. Falls back to 700 for unknown ROCm devices.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, Dict

from .base import BackendAdapter, BackendInfo, Detection, Quote
from .local_cpu import _params_billion_from_artifact, _fallback_response

_TPS_BY_AMD = {
    "MI300X": 3200.0,
    "MI300A": 2400.0,
    "MI250X": 1800.0,
    "MI250": 1500.0,
    "MI210": 1100.0,
    "MI100": 700.0,
    "RX 7900 XTX": 900.0,
    "RX 7900 XT": 750.0,
    "RX 7800 XT": 540.0,
    "Radeon Pro W7900": 1100.0,
}


class LocalROCmBackend(BackendAdapter):
    info = BackendInfo(
        name="local-rocm",
        family="local",
        description="AMD GPU via ROCm/HIP. MI300X, MI250X, Radeon 7900.",
        requires_env=[],
        requires_pip=["torch (+rocm wheel)", "vllm (optional)"],
        docs_url="/compute#local-rocm",
    )

    def detect(self) -> Detection:
        try:
            import torch
        except ImportError:
            return Detection(available=False, reason="torch not installed")
        if not torch.cuda.is_available():
            return Detection(available=False, reason="no torch.cuda device")
        version = getattr(torch.version, "hip", None)
        if not version:
            return Detection(available=False, reason="torch wasn't built with ROCm (use rocm wheel)")
        try:
            name = torch.cuda.get_device_name(0)
        except Exception:
            name = "unknown AMD GPU"
        return Detection(
            available=True,
            reason="ROCm available",
            version=version,
            device_name=name,
        )

    def quote(self, artifact: Path, tokens: int = 1024) -> Quote:
        params_b = _params_billion_from_artifact(artifact)
        tps = self._estimate_tps()
        scaled = tps * (7.0 / max(params_b, 1.0))
        wall = tokens / max(scaled, 50.0)
        return Quote(
            price_usd=0.0,
            wall_seconds=wall,
            cold_start_seconds=7.0,
            notes=f"~{scaled:.0f} tok/s ({params_b:.1f}B params)",
        )

    def _estimate_tps(self) -> float:
        try:
            import torch
            name = torch.cuda.get_device_name(0)
        except Exception:
            return 700.0
        for sku, tps in _TPS_BY_AMD.items():
            if sku in name:
                return tps
        return 700.0

    def run(self, artifact: Path, request: Dict[str, Any]) -> Dict[str, Any]:
        os.environ.setdefault("HIP_VISIBLE_DEVICES", "0")
        from apps.runtime import serve

        t0 = time.time()
        try:
            response = serve.run_request(artifact=str(artifact), request=request, device="cuda")
        except AttributeError:
            response = _fallback_response(request, backend="local-rocm")
        response.setdefault("kolm_compute", {})
        response["kolm_compute"].update({
            "backend": "local-rocm",
            "wall_seconds": time.time() - t0,
            "price_usd": 0.0,
        })
        return response
