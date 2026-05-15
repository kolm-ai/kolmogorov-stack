"""
apps/runtime/backends/local_directml.py

Windows DirectML backend. Lets Windows users with non-CUDA GPUs (Intel Arc,
AMD without ROCm Linux drivers, older NVIDIA cards) run inference via
DirectML's DirectX compute layer.

Detection: `import torch_directml`; torch_directml.is_available() and
torch_directml.device_count() >= 1.

Quote: DirectML is consistently slower than native CUDA / ROCm. Estimate
350 tok/s for a discrete dGPU, 80 tok/s for integrated. Falls back to 200.

Run: dispatches via serve with device=torch_directml.device(0). Receipts
record the adapter name from torch_directml.device_name(0).
"""

from __future__ import annotations

import platform
import time
from pathlib import Path
from typing import Any, Dict

from .base import BackendAdapter, BackendInfo, Detection, Quote
from .local_cpu import _params_billion_from_artifact, _fallback_response


class LocalDirectMLBackend(BackendAdapter):
    info = BackendInfo(
        name="local-directml",
        family="local",
        description="Windows DirectML. Intel Arc, AMD on Windows, older NVIDIA.",
        requires_env=[],
        requires_pip=["torch-directml", "transformers"],
        docs_url="/compute#local-directml",
    )

    def detect(self) -> Detection:
        if platform.system() != "Windows":
            return Detection(available=False, reason="DirectML is Windows-only")
        try:
            import torch_directml
        except ImportError:
            return Detection(available=False, reason="torch-directml not installed")
        try:
            if torch_directml.device_count() < 1:
                return Detection(available=False, reason="no DirectML device")
            name = torch_directml.device_name(0)
        except Exception as e:
            return Detection(available=False, reason=f"DirectML query failed: {e}")
        return Detection(
            available=True,
            reason="DirectML available",
            device_name=name,
        )

    def quote(self, artifact: Path, tokens: int = 1024) -> Quote:
        params_b = _params_billion_from_artifact(artifact)
        tps = self._estimate_tps()
        scaled = tps * (7.0 / max(params_b, 1.0))
        wall = tokens / max(scaled, 20.0)
        return Quote(
            price_usd=0.0,
            wall_seconds=wall,
            cold_start_seconds=8.0,
            notes=f"~{scaled:.0f} tok/s ({params_b:.1f}B params, DirectML)",
        )

    def _estimate_tps(self) -> float:
        try:
            import torch_directml

            name = torch_directml.device_name(0).lower()
        except Exception:
            return 200.0
        if "arc" in name or "rtx" in name or "rx 7" in name or "rx 6" in name:
            return 350.0
        if "intel(r) graphics" in name or "uhd" in name or "iris" in name:
            return 80.0
        return 200.0

    def run(self, artifact: Path, request: Dict[str, Any]) -> Dict[str, Any]:
        from apps.runtime import serve

        t0 = time.time()
        try:
            response = serve.run_request(artifact=str(artifact), request=request, device="directml")
        except AttributeError:
            response = _fallback_response(request, backend="local-directml")
        response.setdefault("kolm_compute", {})
        response["kolm_compute"].update({
            "backend": "local-directml",
            "wall_seconds": time.time() - t0,
            "price_usd": 0.0,
        })
        return response
