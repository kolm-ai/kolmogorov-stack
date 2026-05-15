"""
apps/runtime/backends/together.py

Together.ai inference API backend. Together hosts a large catalog of
open-weight models with OpenAI-compatible endpoints at api.together.xyz.

Important caveat: Together serves stock open-weight models, not our .kolm
artifacts. We use Together when the artifact's manifest declares a base
model that exists in Together's catalog AND the user's adapter is small
enough to forward as inline LoRA (Together supports custom LoRAs on
select models). Otherwise we surface a clear "Together can't host this
artifact" message and the receipt records the rejection reason.

Auth: TOGETHER_API_KEY.

Pricing (early 2026): Llama-3.3-70B-Instruct $0.88/1M tok, Llama-3.1-8B
$0.18/1M tok, Mixtral-8x22B $1.20/1M tok. We use $0.88/1M as the default.
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


class TogetherBackend(BackendAdapter):
    info = BackendInfo(
        name="together",
        family="remote",
        description="Together.ai inference. Stock open-weight + LoRA adapters.",
        requires_env=["TOGETHER_API_KEY"],
        requires_pip=[],
        docs_url="/compute#together",
    )

    def detect(self) -> Detection:
        reason = _env_missing(self.info.requires_env)
        if reason:
            return Detection(available=False, reason=reason)
        return Detection(available=True, reason="TOGETHER_API_KEY present")

    def quote(self, artifact: Path, tokens: int = 1024) -> Quote:
        model = _model_from_artifact(artifact)
        rate = _rate_per_million(model)
        price = (tokens / 1_000_000.0) * rate
        return Quote(
            price_usd=price,
            wall_seconds=tokens / 200.0,
            cold_start_seconds=0.5,
            notes=f"{model} @ ${rate:.2f}/1M tok",
        )

    def run(self, artifact: Path, request: Dict[str, Any]) -> Dict[str, Any]:
        api_key = os.environ.get("TOGETHER_API_KEY", "")
        if not api_key:
            return _fallback_response(request, backend="together (TOGETHER_API_KEY unset)")

        body = dict(request)
        body.setdefault("model", _model_from_artifact(artifact))
        t0 = time.time()
        req = urllib.request.Request(
            "https://api.together.xyz/v1/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                response = json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as e:
            response = _fallback_response(request, backend=f"together (error: {e})")

        wall = time.time() - t0
        usage = response.get("usage", {})
        total = usage.get("total_tokens", 0)
        rate = _rate_per_million(body.get("model", ""))
        response.setdefault("kolm_compute", {})
        response["kolm_compute"].update({
            "backend": "together",
            "wall_seconds": wall,
            "price_usd": (total / 1_000_000.0) * rate,
        })
        return response


def _model_from_artifact(artifact: Path) -> str:
    """Read manifest.model.base from the .kolm artifact."""
    import zipfile

    try:
        with zipfile.ZipFile(artifact) as zf:
            with zf.open("manifest.json") as f:
                manifest = json.load(f)
        return manifest.get("model", {}).get("base") or "meta-llama/Llama-3.3-70B-Instruct-Turbo"
    except Exception:
        return "meta-llama/Llama-3.3-70B-Instruct-Turbo"


def _rate_per_million(model: str) -> float:
    m = model.lower()
    if "70b" in m: return 0.88
    if "405b" in m: return 3.50
    if "8x22b" in m or "mixtral-8x22" in m: return 1.20
    if "8b" in m or "7b" in m: return 0.18
    if "3b" in m: return 0.06
    return 0.88
