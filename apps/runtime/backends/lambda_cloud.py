"""
apps/runtime/backends/lambda_cloud.py

Lambda Labs Cloud backend. On-demand H100/A100 instances. Lambda is a
known-quantity hyperscaler-equivalent without the spot-pricing churn of
Vast or RunPod.

Auth: LAMBDA_API_KEY + KOLM_LAMBDA_INSTANCE_ID (an instance booted from
their kolm-serve image template).

Pricing (early 2026): H100 SXM5 $2.99/hr, H100 PCIe $2.49/hr,
A100 80GB $1.29/hr, A100 40GB $1.10/hr. We default to A100 80GB.
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


class LambdaCloudBackend(BackendAdapter):
    info = BackendInfo(
        name="lambda",
        family="remote",
        description="Lambda Labs Cloud. H100/A100 on-demand, hourly billing.",
        requires_env=["LAMBDA_API_KEY", "KOLM_LAMBDA_INSTANCE_ID"],
        requires_pip=[],
        docs_url="/compute#lambda-cloud",
    )

    def detect(self) -> Detection:
        reason = _env_missing(self.info.requires_env)
        if reason:
            return Detection(available=False, reason=reason)
        return Detection(available=True, reason="LAMBDA_API_KEY + instance id present")

    def quote(self, artifact: Path, tokens: int = 1024) -> Quote:
        params_b = _params_billion_from_artifact(artifact)
        gpu = os.environ.get("KOLM_LAMBDA_GPU", "A100-80")
        if "H100-SXM" in gpu:
            tps, hourly = 4000.0, 2.99
        elif "H100" in gpu:
            tps, hourly = 3800.0, 2.49
        elif "A100-80" in gpu:
            tps, hourly = 2400.0, 1.29
        elif "A100" in gpu:
            tps, hourly = 2200.0, 1.10
        else:
            tps, hourly = 2200.0, 1.50
        scaled = tps * (7.0 / max(params_b, 1.0))
        wall = tokens / max(scaled, 100.0)
        price = (wall / 3600.0) * hourly
        return Quote(
            price_usd=price,
            wall_seconds=wall,
            cold_start_seconds=4.0,
            notes=f"{gpu} ~{scaled:.0f} tok/s @ ${hourly:.2f}/hr",
        )

    def run(self, artifact: Path, request: Dict[str, Any]) -> Dict[str, Any]:
        instance_id = os.environ.get("KOLM_LAMBDA_INSTANCE_ID", "")
        api_key = os.environ.get("LAMBDA_API_KEY", "")
        if not (instance_id and api_key):
            return _fallback_response(request, backend="lambda-cloud (auth missing)")

        endpoint = _resolve_lambda_endpoint(instance_id, api_key)
        if not endpoint:
            return _fallback_response(request, backend="lambda-cloud (instance not active)")

        t0 = time.time()
        req = urllib.request.Request(
            f"{endpoint}/v1/chat/completions",
            data=json.dumps(request).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                response = json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as e:
            response = _fallback_response(request, backend=f"lambda-cloud (error: {e})")

        wall = time.time() - t0
        response.setdefault("kolm_compute", {})
        response["kolm_compute"].update({
            "backend": "lambda",
            "wall_seconds": wall,
            "price_usd": (wall / 3600.0) * 1.29,
        })
        return response


def _resolve_lambda_endpoint(instance_id: str, api_key: str) -> str:
    url = f"https://cloud.lambdalabs.com/api/v1/instances/{instance_id}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {api_key}"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return ""
    inst = data.get("data", {})
    if inst.get("status") != "active":
        return ""
    ip = inst.get("ip")
    if not ip:
        return ""
    return f"http://{ip}:8000"
