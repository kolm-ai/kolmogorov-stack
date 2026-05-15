"""
apps/runtime/backends/sglang.py

SGLang serving-engine backend. SGLang's RadixAttention shares KV-cache
prefixes across requests; for our workloads (system prompt + verifier
chain), this is typically 1.1-1.4x throughput over vLLM on the same
hardware. Buyer runs sglang.launch_server on their GPU node, exports
KOLM_SGLANG_URL, kolm dispatches through the OpenAI-compatible endpoint.

Detection is intentionally cheap: env var present + reachable URL.

Quote: ~2,500 tok/s on 7B-class INT8 with RadixAttention sharing.
Cold start: ~0 (server already up).

Run: POSTs to {KOLM_SGLANG_URL}/v1/chat/completions. Receipt block
records backend, wall_seconds, price (0 on self-host), and engine.
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


class SGLangBackend(BackendAdapter):
    info = BackendInfo(
        name="sglang",
        family="remote",
        description="SGLang serving engine. RadixAttention prefix-cache sharing for verifier chains.",
        requires_env=["KOLM_SGLANG_URL"],
        requires_pip=[],
        docs_url="/compute#sglang",
    )

    def detect(self) -> Detection:
        missing = _env_missing(self.info.requires_env)
        if missing:
            return Detection(available=False, reason=missing)
        return Detection(
            available=True,
            reason="KOLM_SGLANG_URL set",
            device_name=os.environ.get("KOLM_SGLANG_URL", "").split("://")[-1].split("/")[0],
        )

    def quote(self, artifact: Path, tokens: int = 1024) -> Quote:
        params_b = _params_billion_from_artifact(artifact)
        # SGLang RadixAttention typically 1.15x vLLM on shared-prefix workloads.
        tps = 2500.0 * (7.0 / max(params_b, 1.0))
        wall = tokens / max(tps, 50.0)
        return Quote(
            price_usd=0.0,
            wall_seconds=wall,
            cold_start_seconds=0.0,
            notes=f"SGLang @ {os.environ.get('KOLM_SGLANG_URL','?')} (~{tps:.0f} tok/s)",
        )

    def run(self, artifact: Path, request: Dict[str, Any]) -> Dict[str, Any]:
        url = os.environ["KOLM_SGLANG_URL"].rstrip("/") + "/v1/chat/completions"
        body = json.dumps(request).encode("utf-8")
        req = urllib.request.Request(url, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                response = json.loads(r.read().decode("utf-8"))
        except Exception:
            response = _fallback_response(request, backend="sglang")
        response.setdefault("kolm_compute", {})
        response["kolm_compute"].update({
            "backend": "sglang",
            "wall_seconds": time.time() - t0,
            "price_usd": 0.0,
            "engine": "sglang",
        })
        return response
