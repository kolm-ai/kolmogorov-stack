"""
apps/runtime/backends/replicate.py

Replicate.com backend. Replicate exposes models via a predict() API that
returns a stream of outputs. We use it for the same constrained set of
"Together-like" workloads: stock open-weight bases, with adapter forwarding
when the model supports it (Replicate has a "lora_url" param on Llama
serverless deployments).

Auth: REPLICATE_API_TOKEN.

Pricing (early 2026): A100 80GB at $0.001525 per second (~$5.49/hr).
For a typical 1024-token reply at ~2400 tok/s on 7B, that's ~$0.0007.
"""

from __future__ import annotations

import json
import os
import time
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any, Dict

from .base import BackendAdapter, BackendInfo, Detection, Quote, _env_missing
from .local_cpu import _fallback_response


class ReplicateBackend(BackendAdapter):
    info = BackendInfo(
        name="replicate",
        family="remote",
        description="Replicate predict API. Llama serverless w/ LoRA URL.",
        requires_env=["REPLICATE_API_TOKEN", "KOLM_REPLICATE_VERSION"],
        requires_pip=[],
        docs_url="/compute#replicate",
    )

    def detect(self) -> Detection:
        reason = _env_missing(self.info.requires_env)
        if reason:
            return Detection(available=False, reason=reason)
        return Detection(available=True, reason="REPLICATE_API_TOKEN + version present")

    def quote(self, artifact: Path, tokens: int = 1024) -> Quote:
        tps = 2400.0
        wall = tokens / tps
        price = wall * 0.001525
        return Quote(
            price_usd=price,
            wall_seconds=wall,
            cold_start_seconds=18.0,
            notes=f"A100 80GB @ $0.001525/s",
        )

    def run(self, artifact: Path, request: Dict[str, Any]) -> Dict[str, Any]:
        token = os.environ.get("REPLICATE_API_TOKEN", "")
        version = os.environ.get("KOLM_REPLICATE_VERSION", "")
        if not (token and version):
            return _fallback_response(request, backend="replicate (auth/version missing)")

        messages = request.get("messages", [])
        prompt = "\n".join(m.get("content", "") for m in messages if isinstance(m, dict))
        max_tokens = int(request.get("max_tokens", 256))

        payload = {
            "version": version,
            "input": {
                "prompt": prompt,
                "max_new_tokens": max_tokens,
                "temperature": request.get("temperature", 0.7),
            },
        }
        adapter_url = os.environ.get("KOLM_REPLICATE_LORA_URL")
        if adapter_url:
            payload["input"]["lora_url"] = adapter_url

        t0 = time.time()
        req = urllib.request.Request(
            "https://api.replicate.com/v1/predictions",
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Token {token}",
                "Prefer": "wait",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                envelope = json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as e:
            return _fallback_response(request, backend=f"replicate (error: {e})")

        output = envelope.get("output")
        if isinstance(output, list):
            text = "".join(output)
        elif isinstance(output, str):
            text = output
        else:
            text = ""

        wall = time.time() - t0
        return {
            "id": envelope.get("id", "kolm-replicate"),
            "object": "chat.completion",
            "model": request.get("model", "replicate"),
            "choices": [
                {"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}
            ],
            "usage": {"prompt_tokens": len(prompt.split()), "completion_tokens": len(text.split()), "total_tokens": 0},
            "kolm_compute": {
                "backend": "replicate",
                "wall_seconds": wall,
                "price_usd": wall * 0.001525,
                "prediction_id": envelope.get("id"),
            },
        }
