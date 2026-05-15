"""replicate: Replicate Cog containers.

Required env vars:
  KOLM_REPLICATE_TOKEN  : Replicate API token
  KOLM_REPLICATE_MODEL  : owner/name:version of a kolm-trainer Cog model

The Cog model is expected to accept ``{spec: {...}}`` and return
``{metrics: {...}, adapter_bytes: <base64>, adapter_filename: "..."}``.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import os
import time
from pathlib import Path
from typing import Any, Callable

import httpx


def _check() -> tuple[str, str]:
    token = os.environ.get("KOLM_REPLICATE_TOKEN") or os.environ.get("REPLICATE_API_TOKEN")
    if not token:
        raise RuntimeError("replicate: KOLM_REPLICATE_TOKEN not set. Get one at https://replicate.com/account/api-tokens")
    model = os.environ.get("KOLM_REPLICATE_MODEL")
    if not model:
        raise RuntimeError("replicate: KOLM_REPLICATE_MODEL not set (e.g. ``you/kolm-trainer:abcd1234``)")
    return token, model


async def run(job, adapter_dir: Path, on_progress: Callable[[str, int], None]) -> dict[str, Any]:
    token, model = _check()
    headers = {"Authorization": f"Token {token}", "Content-Type": "application/json"}

    on_progress("replicate:submitting", 5)
    started_at = time.time()

    body = {
        "version": model.split(":")[-1] if ":" in model else model,
        "input": {
            "spec": {
                "tenant": job.tenant,
                "namespace": job.namespace,
                "base_model": job.base_model,
                "target_size": job.target_size,
                "pair_count": job.pair_count,
                "corpus_url": job.corpus_url,
                "holdout_ratio": job.holdout_ratio,
            },
        },
    }

    async with httpx.AsyncClient(timeout=60) as client:
        sub = await client.post("https://api.replicate.com/v1/predictions", headers=headers, json=body)
        if sub.status_code >= 400:
            raise RuntimeError(f"replicate: submit failed ({sub.status_code}): {sub.text[:300]}")
        sub_data = sub.json()
        prediction_id = sub_data.get("id")
        if not prediction_id:
            raise RuntimeError(f"replicate: no id in response: {sub_data}")

        on_progress("replicate:running", 20)
        deadline = time.time() + int(os.environ.get("KOLM_REPLICATE_TIMEOUT_SECONDS", "3600"))
        result = None
        while time.time() < deadline:
            await asyncio.sleep(5)
            ck = await client.get(f"https://api.replicate.com/v1/predictions/{prediction_id}", headers=headers)
            if ck.status_code >= 400:
                raise RuntimeError(f"replicate: poll failed ({ck.status_code}): {ck.text[:300]}")
            data = ck.json()
            status = data.get("status")
            if status == "succeeded":
                result = data.get("output")
                break
            if status in {"failed", "canceled"}:
                raise RuntimeError(f"replicate: prediction {status}: {data.get('error') or '(no error)'}")
            on_progress(f"replicate:{status}", 50)

    if not result or not isinstance(result, dict) or "metrics" not in result:
        raise RuntimeError(f"replicate: unexpected result shape: {type(result).__name__}")

    adapter_bytes = base64.b64decode(result.get("adapter_bytes", ""))
    if not adapter_bytes:
        raise RuntimeError("replicate: no adapter bytes in result")
    filename = result.get("adapter_filename", f"{job.job_id}.replicate.zip")
    out_path = adapter_dir / filename
    out_path.write_bytes(adapter_bytes)
    sha = hashlib.sha256(adapter_bytes).hexdigest()
    finished_at = time.time()

    on_progress("replicate:complete", 100)
    return {
        "metrics": {**result["metrics"], "backend": "replicate"},
        "adapter": {
            "url": f"file://{out_path.resolve()}",
            "sha256": "sha256-" + sha,
            "size_bytes": len(adapter_bytes),
            "format": result.get("adapter_format", "peft-lora"),
        },
        "compute": {
            "backend": "replicate",
            "device": result.get("device", "replicate-gpu"),
            "cost_usd": result.get("cost_usd"),
            "started_at": started_at,
            "finished_at": finished_at,
            "duration_seconds": round(finished_at - started_at, 3),
            "provenance": {
                "replicate_prediction_id": prediction_id,
                "replicate_model": model,
            },
        },
    }
