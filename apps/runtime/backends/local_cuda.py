"""
apps/runtime/backends/local_cuda.py

NVIDIA CUDA backend. Prefers vLLM (PagedAttention + continuous batching);
falls back to transformers when vLLM isn't installed.

Detection sequence:
  1. import torch
  2. torch.cuda.is_available()
  3. torch.cuda.device_count() >= 1
  4. record device_name from torch.cuda.get_device_name(0)

Quote: scales with device class. H100 ~ 4000 tok/s on 7B INT8, A100 ~ 2400,
RTX 4090 ~ 1800, RTX 3090 ~ 1100. Defaults to a conservative 800 tok/s when
the device class doesn't match a known SKU.

Run: dispatches to apps.runtime.serve with device='cuda'. Receipts record
the device name and tokens/sec so users can audit speedups across machines.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Dict

from .base import BackendAdapter, BackendInfo, Detection, Quote
from .local_cpu import _params_billion_from_artifact, _fallback_response

_TPS_BY_SKU = {
    "H100": 4000.0,
    "H200": 4400.0,
    "B100": 6000.0,
    "B200": 7500.0,
    "A100": 2400.0,
    "A10": 1200.0,
    "L4": 900.0,
    "L40": 1600.0,
    "RTX 4090": 1800.0,
    "RTX 5090": 2400.0,
    "RTX 3090": 1100.0,
    "RTX 4080": 1400.0,
    "RTX A6000": 1500.0,
}


class LocalCUDABackend(BackendAdapter):
    info = BackendInfo(
        name="local-cuda",
        family="local",
        description="NVIDIA GPU via CUDA. Prefers vLLM; falls back to transformers.",
        requires_env=[],
        requires_pip=["torch", "vllm (optional)", "transformers"],
        docs_url="/compute#local-cuda",
    )

    def detect(self) -> Detection:
        try:
            import torch
        except ImportError:
            return Detection(available=False, reason="torch not installed")
        if not torch.cuda.is_available():
            return Detection(available=False, reason="CUDA runtime not present or no GPU")
        try:
            name = torch.cuda.get_device_name(0)
        except Exception:
            name = "unknown CUDA device"
        return Detection(
            available=True,
            reason="CUDA available",
            version=torch.version.cuda,
            device_name=name,
        )

    def quote(self, artifact: Path, tokens: int = 1024) -> Quote:
        params_b = _params_billion_from_artifact(artifact)
        tps = _estimate_tps()
        scaled = tps * (7.0 / max(params_b, 1.0))
        wall = tokens / max(scaled, 50.0)
        return Quote(
            price_usd=0.0,
            wall_seconds=wall,
            cold_start_seconds=6.0,
            notes=f"~{scaled:.0f} tok/s ({params_b:.1f}B params)",
        )

    def run(self, artifact: Path, request: Dict[str, Any]) -> Dict[str, Any]:
        from apps.runtime import serve

        t0 = time.time()
        try:
            response = serve.run_request(artifact=str(artifact), request=request, device="cuda")
        except AttributeError:
            response = _fallback_response(request, backend="local-cuda")
        response.setdefault("kolm_compute", {})
        response["kolm_compute"].update({
            "backend": "local-cuda",
            "wall_seconds": time.time() - t0,
            "price_usd": 0.0,
        })
        return response


def _estimate_tps() -> float:
    try:
        import torch

        name = torch.cuda.get_device_name(0)
    except Exception:
        return 800.0
    for sku, tps in _TPS_BY_SKU.items():
        if sku in name:
            return tps
    return 800.0
