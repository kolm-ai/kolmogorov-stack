"""
apps/runtime/backends/local_mps.py

Apple Silicon Metal Performance Shaders backend. Used when MLX isn't
available; MLX is generally faster on M-series for our workloads.

Detection: torch.backends.mps.is_available() + torch.backends.mps.is_built().

Quote: M2 Max ~ 350 tok/s on 7B INT8, M3 Max ~ 480, M4 Max ~ 620.
Falls back to a conservative 250 tok/s if the chip can't be inferred.

Run: dispatches to apps.runtime.serve with device='mps'. transformers
supports MPS for most architectures; we don't use vLLM here.
"""

from __future__ import annotations

import platform
import subprocess
import time
from pathlib import Path
from typing import Any, Dict

from .base import BackendAdapter, BackendInfo, Detection, Quote
from .local_cpu import _params_billion_from_artifact, _fallback_response


class LocalMPSBackend(BackendAdapter):
    info = BackendInfo(
        name="local-mps",
        family="local",
        description="Apple Silicon via Metal Performance Shaders.",
        requires_env=[],
        requires_pip=["torch", "transformers"],
        docs_url="/compute#local-mps",
    )

    def detect(self) -> Detection:
        try:
            import torch
        except ImportError:
            return Detection(available=False, reason="torch not installed")
        try:
            if not torch.backends.mps.is_available():
                return Detection(available=False, reason="MPS not available")
            if not torch.backends.mps.is_built():
                return Detection(available=False, reason="torch not built with MPS")
        except AttributeError:
            return Detection(available=False, reason="MPS attributes missing (old torch)")
        chip = _detect_apple_chip()
        return Detection(
            available=True,
            reason="MPS available",
            device_name=chip or "Apple Silicon",
        )

    def quote(self, artifact: Path, tokens: int = 1024) -> Quote:
        params_b = _params_billion_from_artifact(artifact)
        tps = _tps_for_chip()
        scaled = tps * (7.0 / max(params_b, 1.0))
        wall = tokens / max(scaled, 30.0)
        return Quote(
            price_usd=0.0,
            wall_seconds=wall,
            cold_start_seconds=5.0,
            notes=f"~{scaled:.0f} tok/s ({params_b:.1f}B params)",
        )

    def run(self, artifact: Path, request: Dict[str, Any]) -> Dict[str, Any]:
        from apps.runtime import serve

        t0 = time.time()
        try:
            response = serve.run_request(artifact=str(artifact), request=request, device="mps")
        except AttributeError:
            response = _fallback_response(request, backend="local-mps")
        response.setdefault("kolm_compute", {})
        response["kolm_compute"].update({
            "backend": "local-mps",
            "wall_seconds": time.time() - t0,
            "price_usd": 0.0,
        })
        return response


def _detect_apple_chip() -> str:
    if platform.system() != "Darwin":
        return ""
    try:
        out = subprocess.run(
            ["sysctl", "-n", "machdep.cpu.brand_string"],
            capture_output=True, text=True, timeout=2.0
        )
        return out.stdout.strip()
    except Exception:
        return ""


def _tps_for_chip() -> float:
    chip = _detect_apple_chip()
    if "M4 Max" in chip: return 620.0
    if "M4 Pro" in chip: return 420.0
    if "M4" in chip: return 280.0
    if "M3 Max" in chip: return 480.0
    if "M3 Pro" in chip: return 340.0
    if "M3" in chip: return 230.0
    if "M2 Max" in chip: return 350.0
    if "M2 Pro" in chip: return 260.0
    if "M2" in chip: return 180.0
    if "M1 Max" in chip: return 280.0
    if "M1 Pro" in chip: return 200.0
    if "M1" in chip: return 140.0
    return 250.0
