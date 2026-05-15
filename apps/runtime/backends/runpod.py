"""
apps/runtime/backends/runpod.py

RunPod serverless backend. We support both /run (async) and /runsync
(blocking) endpoints; we use /runsync for kolm's request-response shape.

Auth: RUNPOD_API_KEY + KOLM_RUNPOD_ENDPOINT_ID (the endpoint that has
your kolm-serve image pre-deployed).

Pricing (early 2026): H100 PCIe $2.49/hr, H100 SXM $3.89/hr, A100 80GB
$1.89/hr, RTX 4090 $0.69/hr. We default to A100 80GB pricing.

Cold start: RunPod's flash-boot keeps containers warm; we quote 6s for
warm requests, 20-40s for cold.
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
from .local_cpu import _params_billion_from_artifact, _fallback_response


class RunPodBackend(BackendAdapter):
    info = BackendInfo(
        name="runpod",
        family="remote",
        description="RunPod serverless. H100/A100/4090. Per-second billing.",
        requires_env=["RUNPOD_API_KEY", "KOLM_RUNPOD_ENDPOINT_ID"],
        requires_pip=[],
        docs_url="/compute#runpod",
    )

    def detect(self) -> Detection:
        reason = _env_missing(self.info.requires_env)
        if reason:
            return Detection(available=False, reason=reason)
        return Detection(available=True, reason="RUNPOD_API_KEY + endpoint id present")

    def quote(self, artifact: Path, tokens: int = 1024) -> Quote:
        params_b = _params_billion_from_artifact(artifact)
        gpu = os.environ.get("KOLM_RUNPOD_GPU", "A100-80")
        if "H100-SXM" in gpu:
            tps, hourly = 4000.0, 3.89
        elif "H100" in gpu:
            tps, hourly = 3800.0, 2.49
        elif "A100" in gpu:
            tps, hourly = 2400.0, 1.89
        elif "4090" in gpu:
            tps, hourly = 1800.0, 0.69
        else:
            tps, hourly = 2000.0, 1.50
        scaled = tps * (7.0 / max(params_b, 1.0))
        wall = tokens / max(scaled, 100.0)
        price = (wall / 3600.0) * hourly
        return Quote(
            price_usd=price,
            wall_seconds=wall,
            cold_start_seconds=6.0,
            notes=f"{gpu} ~{scaled:.0f} tok/s @ ${hourly:.2f}/hr",
        )

    def run(self, artifact: Path, request: Dict[str, Any]) -> Dict[str, Any]:
        endpoint_id = os.environ.get("KOLM_RUNPOD_ENDPOINT_ID", "")
        api_key = os.environ.get("RUNPOD_API_KEY", "")
        if not endpoint_id or not api_key:
            return _fallback_response(request, backend="runpod (auth missing)")

        url = f"https://api.runpod.ai/v2/{endpoint_id}/runsync"
        payload = {"input": request}
        t0 = time.time()
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                envelope = json.loads(resp.read().decode("utf-8"))
            response = envelope.get("output") or envelope
        except urllib.error.URLError as e:
            response = _fallback_response(request, backend=f"runpod (error: {e})")

        wall = time.time() - t0
        response.setdefault("kolm_compute", {})
        response["kolm_compute"].update({
            "backend": "runpod",
            "wall_seconds": wall,
            "price_usd": (wall / 3600.0) * 1.89,
        })
        return response
