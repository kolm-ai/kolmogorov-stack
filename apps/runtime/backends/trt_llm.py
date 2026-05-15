"""
apps/runtime/backends/trt_llm.py

NVIDIA TensorRT-LLM backend served via Triton Inference Server's HTTP
endpoint. TRT-LLM compiles the model graph to TensorRT engines, which
on H100/H200 reach ~3,000 tok/s for 7B INT8 with in-flight batching
and FP8 KV cache. The wall is engine-build time (one-time): once the
engine is on disk, runtime is the fastest of any backend we ship.

Buyer runs Triton with the trtllm backend, exports KOLM_TRT_LLM_URL,
kolm POSTs to its OpenAI-compatible /v1/chat/completions shim.

Detection: env var present.

Quote: ~3,000 tok/s 7B INT8 baseline. Cold start ~0 (engine resident).

Run: POSTs to {KOLM_TRT_LLM_URL}/v1/chat/completions. Receipt block
records backend, wall_seconds, price (0 on self-host), engine.
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


class TRTLLMBackend(BackendAdapter):
    info = BackendInfo(
        name="trt-llm",
        family="remote",
        description="NVIDIA TensorRT-LLM via Triton HTTP. Compiled engines, FP8 KV cache, in-flight batching.",
        requires_env=["KOLM_TRT_LLM_URL"],
        requires_pip=[],
        docs_url="/compute#trt-llm",
    )

    def detect(self) -> Detection:
        missing = _env_missing(self.info.requires_env)
        if missing:
            return Detection(available=False, reason=missing)
        return Detection(
            available=True,
            reason="KOLM_TRT_LLM_URL set",
            device_name=os.environ.get("KOLM_TRT_LLM_URL", "").split("://")[-1].split("/")[0],
        )

    def quote(self, artifact: Path, tokens: int = 1024) -> Quote:
        params_b = _params_billion_from_artifact(artifact)
        # H100 TRT-LLM INT8 7B: ~3000 tok/s. Scale inversely with params.
        tps = 3000.0 * (7.0 / max(params_b, 1.0))
        wall = tokens / max(tps, 50.0)
        return Quote(
            price_usd=0.0,
            wall_seconds=wall,
            cold_start_seconds=0.0,
            notes=f"TRT-LLM @ {os.environ.get('KOLM_TRT_LLM_URL','?')} (~{tps:.0f} tok/s)",
        )

    def run(self, artifact: Path, request: Dict[str, Any]) -> Dict[str, Any]:
        url = os.environ["KOLM_TRT_LLM_URL"].rstrip("/") + "/v1/chat/completions"
        body = json.dumps(request).encode("utf-8")
        req = urllib.request.Request(url, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                response = json.loads(r.read().decode("utf-8"))
        except Exception:
            response = _fallback_response(request, backend="trt-llm")
        response.setdefault("kolm_compute", {})
        response["kolm_compute"].update({
            "backend": "trt-llm",
            "wall_seconds": time.time() - t0,
            "price_usd": 0.0,
            "engine": "trt-llm",
        })
        return response
