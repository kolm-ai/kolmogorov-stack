"""
apps/runtime/backends/fal.py

fal.ai backend. fal is known for image/video models but also serves LLMs
via its serverless function API. We use queue.fal.run for sync requests.

Auth: FAL_KEY + KOLM_FAL_APP (the fal app id that wraps kolm-serve).

Pricing (early 2026): A100 ~ $0.002083/s, H100 ~ $0.00277/s. fal bills
per second of GPU wall time. Cold starts are fast (typically <3s) because
fal aggressively keeps workers warm.
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


class FalBackend(BackendAdapter):
    info = BackendInfo(
        name="fal",
        family="remote",
        description="fal.ai serverless. A100/H100, sub-3s cold starts.",
        requires_env=["FAL_KEY", "KOLM_FAL_APP"],
        requires_pip=[],
        docs_url="/compute#fal",
    )

    def detect(self) -> Detection:
        reason = _env_missing(self.info.requires_env)
        if reason:
            return Detection(available=False, reason=reason)
        return Detection(available=True, reason="FAL_KEY + app id present")

    def quote(self, artifact: Path, tokens: int = 1024) -> Quote:
        gpu = os.environ.get("KOLM_FAL_GPU", "A100")
        per_sec = 0.00277 if "H100" in gpu else 0.002083
        tps = 3800.0 if "H100" in gpu else 2400.0
        wall = tokens / tps
        price = wall * per_sec
        return Quote(
            price_usd=price,
            wall_seconds=wall,
            cold_start_seconds=2.5,
            notes=f"{gpu} ~{tps:.0f} tok/s @ ${per_sec:.5f}/s",
        )

    def run(self, artifact: Path, request: Dict[str, Any]) -> Dict[str, Any]:
        key = os.environ.get("FAL_KEY", "")
        app = os.environ.get("KOLM_FAL_APP", "")
        if not (key and app):
            return _fallback_response(request, backend="fal (auth/app missing)")

        url = f"https://queue.fal.run/{app}"
        t0 = time.time()
        req = urllib.request.Request(
            url,
            data=json.dumps(request).encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Key {key}",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                response = json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as e:
            response = _fallback_response(request, backend=f"fal (error: {e})")

        wall = time.time() - t0
        per_sec = 0.00277 if os.environ.get("KOLM_FAL_GPU", "A100") == "H100" else 0.002083
        response.setdefault("kolm_compute", {})
        response["kolm_compute"].update({
            "backend": "fal",
            "wall_seconds": wall,
            "price_usd": wall * per_sec,
        })
        return response
