"""
apps/runtime/backends/tgi.py

HuggingFace Text Generation Inference (TGI) backend. TGI is the
serving engine HF ships for their inference endpoints; many enterprise
buyers already have it standing up because it's the path of least
resistance from the HF Hub. Buyer runs the TGI container, exports
KOLM_TGI_URL, kolm dispatches over the /v1/chat/completions endpoint
(TGI ships an OpenAI-compatible shim).

Detection: env var present + reachable. We don't probe /info on detect.

Quote: ~1,800 tok/s for 7B INT8 on A100. TGI is slower than vLLM/SGLang
on dense decode but matches them on prefill-heavy workloads and ships
with FlashAttention-2 by default.

Run: POSTs to {KOLM_TGI_URL}/v1/chat/completions. kolm_compute receipt
block records backend, wall_seconds, price (0 on self-host), engine.
"""

from __future__ import annotations

import json
import os
import time
import urllib.request
from pathlib import Path
from typing import Any, Dict

from .base import BackendAdapter, BackendInfo, Detection, Quote, _env_missing
from .local_cpu import _params_billion_from_artifact, _fallback_response


class TGIBackend(BackendAdapter):
    info = BackendInfo(
        name="tgi",
        family="remote",
        description="HuggingFace Text Generation Inference. FlashAttention-2, OpenAI-compatible shim.",
        requires_env=["KOLM_TGI_URL"],
        requires_pip=[],
        docs_url="/compute#tgi",
    )

    def detect(self) -> Detection:
        missing = _env_missing(self.info.requires_env)
        if missing:
            return Detection(available=False, reason=missing)
        return Detection(
            available=True,
            reason="KOLM_TGI_URL set",
            device_name=os.environ.get("KOLM_TGI_URL", "").split("://")[-1].split("/")[0],
        )

    def quote(self, artifact: Path, tokens: int = 1024) -> Quote:
        params_b = _params_billion_from_artifact(artifact)
        # TGI on A100 INT8: ~1800 tok/s 7B, scales inversely with params.
        tps = 1800.0 * (7.0 / max(params_b, 1.0))
        wall = tokens / max(tps, 50.0)
        return Quote(
            price_usd=0.0,
            wall_seconds=wall,
            cold_start_seconds=0.0,
            notes=f"TGI @ {os.environ.get('KOLM_TGI_URL','?')} (~{tps:.0f} tok/s)",
        )

    def run(self, artifact: Path, request: Dict[str, Any]) -> Dict[str, Any]:
        url = os.environ["KOLM_TGI_URL"].rstrip("/") + "/v1/chat/completions"
        body = json.dumps(request).encode("utf-8")
        req = urllib.request.Request(url, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                response = json.loads(r.read().decode("utf-8"))
        except Exception:
            response = _fallback_response(request, backend="tgi")
        response.setdefault("kolm_compute", {})
        response["kolm_compute"].update({
            "backend": "tgi",
            "wall_seconds": time.time() - t0,
            "price_usd": 0.0,
            "engine": "tgi",
        })
        return response
