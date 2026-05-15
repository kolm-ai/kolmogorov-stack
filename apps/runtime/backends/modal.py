"""
apps/runtime/backends/modal.py

Modal Labs serverless GPU backend. Modal spins up a container with the
.kolm artifact mounted and exposes /v1/chat/completions for the lifetime
of the request. We use Modal's HTTP function endpoints.

Auth: MODAL_TOKEN_ID + MODAL_TOKEN_SECRET (Modal's default env vars).

Quote: Modal H100 is $5.92/hr, A100 80GB is $4.00/hr. Token throughput
on H100 ~ 3800 tok/s for 7B INT8. Price per 1K tok ~ $0.00043.

Cold start: Modal typically 4-12s for warm pool, up to 90s for first boot.
We quote 8s as the median expected.
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


class ModalBackend(BackendAdapter):
    info = BackendInfo(
        name="modal",
        family="remote",
        description="Modal Labs serverless GPU. H100/A100. Per-second billing.",
        requires_env=["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"],
        requires_pip=["modal (for deploy step only)"],
        docs_url="/compute#modal",
    )

    def detect(self) -> Detection:
        reason = _env_missing(self.info.requires_env)
        if reason:
            return Detection(available=False, reason=reason)
        return Detection(available=True, reason="MODAL_TOKEN_* present")

    def quote(self, artifact: Path, tokens: int = 1024) -> Quote:
        params_b = _params_billion_from_artifact(artifact)
        gpu = os.environ.get("KOLM_MODAL_GPU", "H100")
        tps = 3800.0 if gpu == "H100" else 2400.0
        price_per_hour = 5.92 if gpu == "H100" else 4.00
        scaled = tps * (7.0 / max(params_b, 1.0))
        wall = tokens / max(scaled, 100.0)
        price = (wall / 3600.0) * price_per_hour
        return Quote(
            price_usd=price,
            wall_seconds=wall,
            cold_start_seconds=8.0,
            notes=f"{gpu} ~{scaled:.0f} tok/s @ ${price_per_hour:.2f}/hr",
        )

    def run(self, artifact: Path, request: Dict[str, Any]) -> Dict[str, Any]:
        endpoint = os.environ.get("KOLM_MODAL_ENDPOINT")
        if not endpoint:
            return _fallback_response(request, backend="modal (KOLM_MODAL_ENDPOINT unset)")
        token_id = os.environ.get("MODAL_TOKEN_ID", "")
        token_secret = os.environ.get("MODAL_TOKEN_SECRET", "")

        t0 = time.time()
        body = json.dumps(request).encode("utf-8")
        req = urllib.request.Request(
            endpoint,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Modal-Key": token_id,
                "Modal-Secret": token_secret,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                response = json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as e:
            response = _fallback_response(request, backend=f"modal (error: {e})")

        wall = time.time() - t0
        response.setdefault("kolm_compute", {})
        response["kolm_compute"].update({
            "backend": "modal",
            "wall_seconds": wall,
            "price_usd": (wall / 3600.0) * 5.92,
        })
        return response
