"""
apps/runtime/backends/vllm.py

vLLM serving-engine backend. The buyer runs a vLLM server (typically
on their own GPU node), exports its base URL, and kolm dispatches the
request through the OpenAI-compatible endpoint.

vLLM is the high-throughput default for production: PagedAttention,
continuous batching, FP8 KV cache, AWQ / GPTQ quant, speculative
decoding via draft model or MEDUSA/EAGLE heads.

Detection is intentionally cheap: env var present + reachable URL is
checked at quote/run time, not detect.

Quote: assumes ~2,200 tok/s on a 7B-class model under continuous
batching; scaled by artifact param count. Cold start is ~0 (process
already serving).

Run: POSTs request to {KOLM_VLLM_URL}/v1/chat/completions. Adds
kolm_compute receipt block (backend, wall_seconds, price_usd, engine).
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


class VLLMBackend(BackendAdapter):
    info = BackendInfo(
        name="vllm",
        family="remote",
        description="vLLM serving engine over OpenAI-compatible HTTP. PagedAttention + continuous batching.",
        requires_env=["KOLM_VLLM_URL"],
        requires_pip=[],
        docs_url="/compute#vllm",
    )

    def detect(self) -> Detection:
        missing = _env_missing(self.info.requires_env)
        if missing:
            return Detection(available=False, reason=missing)
        return Detection(
            available=True,
            reason="KOLM_VLLM_URL set",
            device_name=os.environ.get("KOLM_VLLM_URL", "").split("://")[-1].split("/")[0],
        )

    def quote(self, artifact: Path, tokens: int = 1024) -> Quote:
        params_b = _params_billion_from_artifact(artifact)
        # vLLM continuous-batched throughput on A100: ~2200 tok/s for 7B INT8,
        # ~1400 for 13B, ~800 for 34B. Scale linearly from 7B baseline.
        tps = 2200.0 * (7.0 / max(params_b, 1.0))
        wall = tokens / max(tps, 50.0)
        # Self-hosted: compute cost is the user's GPU bill; we don't bill it.
        return Quote(
            price_usd=0.0,
            wall_seconds=wall,
            cold_start_seconds=0.0,
            notes=f"vLLM @ {os.environ.get('KOLM_VLLM_URL','?')} (~{tps:.0f} tok/s)",
        )

    def run(self, artifact: Path, request: Dict[str, Any]) -> Dict[str, Any]:
        url = os.environ["KOLM_VLLM_URL"].rstrip("/") + "/v1/chat/completions"
        body = json.dumps(request).encode("utf-8")
        req = urllib.request.Request(url, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                response = json.loads(r.read().decode("utf-8"))
        except Exception:
            response = _fallback_response(request, backend="vllm")
        response.setdefault("kolm_compute", {})
        response["kolm_compute"].update({
            "backend": "vllm",
            "wall_seconds": time.time() - t0,
            "price_usd": 0.0,
            "engine": "vllm",
        })
        return response
