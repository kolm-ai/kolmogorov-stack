"""
apps/runtime/backends/vast.py

Vast.ai backend. Vast is a GPU marketplace; cheaper than hyperscalers but
spot-priced. We attach to a user-rented Vast instance via the vast CLI's
generated SSH endpoint.

Auth: VAST_API_KEY plus KOLM_VAST_INSTANCE_ID (an instance the user has
already rented with the kolm-serve image).

Pricing: Vast spot prices vary wildly. Median H100 PCIe ~ $1.80/hr,
A100 80GB ~ $1.20/hr, RTX 4090 ~ $0.40/hr. We default to A100 80GB.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any, Dict

from .base import BackendAdapter, BackendInfo, Detection, Quote, _env_missing
from .local_cpu import _params_billion_from_artifact, _fallback_response


class VastBackend(BackendAdapter):
    info = BackendInfo(
        name="vast",
        family="remote",
        description="Vast.ai marketplace. Cheap spot GPUs via the kolm-serve image.",
        requires_env=["VAST_API_KEY", "KOLM_VAST_INSTANCE_ID"],
        requires_pip=[],
        docs_url="/compute#vast",
    )

    def detect(self) -> Detection:
        reason = _env_missing(self.info.requires_env)
        if reason:
            return Detection(available=False, reason=reason)
        return Detection(available=True, reason="VAST_API_KEY + instance id present")

    def quote(self, artifact: Path, tokens: int = 1024) -> Quote:
        params_b = _params_billion_from_artifact(artifact)
        gpu = os.environ.get("KOLM_VAST_GPU", "A100-80")
        if "H100" in gpu:
            tps, hourly = 3800.0, 1.80
        elif "A100" in gpu:
            tps, hourly = 2400.0, 1.20
        elif "4090" in gpu:
            tps, hourly = 1800.0, 0.40
        else:
            tps, hourly = 1800.0, 0.60
        scaled = tps * (7.0 / max(params_b, 1.0))
        wall = tokens / max(scaled, 100.0)
        price = (wall / 3600.0) * hourly
        return Quote(
            price_usd=price,
            wall_seconds=wall,
            cold_start_seconds=12.0,
            notes=f"{gpu} ~{scaled:.0f} tok/s @ ${hourly:.2f}/hr (spot)",
        )

    def run(self, artifact: Path, request: Dict[str, Any]) -> Dict[str, Any]:
        instance = os.environ.get("KOLM_VAST_INSTANCE_ID", "")
        if not instance:
            return _fallback_response(request, backend="vast (instance id missing)")

        endpoint = _resolve_vast_endpoint(instance)
        if not endpoint:
            return _fallback_response(request, backend="vast (instance not running)")

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
            response = _fallback_response(request, backend=f"vast (error: {e})")

        wall = time.time() - t0
        response.setdefault("kolm_compute", {})
        response["kolm_compute"].update({
            "backend": "vast",
            "wall_seconds": wall,
            "price_usd": (wall / 3600.0) * 1.20,
        })
        return response


def _resolve_vast_endpoint(instance_id: str) -> str:
    """Query Vast for the public IP + port mapping for port 8000."""
    api_key = os.environ.get("VAST_API_KEY", "")
    if not api_key:
        return ""
    url = f"https://console.vast.ai/api/v0/instances/?api_key={api_key}"
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return ""
    for inst in data.get("instances", []):
        if str(inst.get("id")) != str(instance_id):
            continue
        if inst.get("actual_status") != "running":
            return ""
        host = inst.get("public_ipaddr")
        ports = inst.get("ports", {}) or {}
        port_8000 = ports.get("8000/tcp")
        if host and port_8000:
            return f"http://{host}:{port_8000[0]['HostPort']}"
    return ""
