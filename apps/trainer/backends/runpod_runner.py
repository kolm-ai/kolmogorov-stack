"""runpod: RunPod Serverless endpoint. Submit a job to a pre-deployed
serverless endpoint, poll for output, download the adapter blob.

Required env vars:
  KOLM_RUNPOD_TOKEN     : your RunPod API key
  KOLM_RUNPOD_ENDPOINT  : endpoint ID (e.g. ``abc123def``) for the kolm-trainer worker

The worker container must accept ``{"spec": {...}}`` and return
``{"metrics": {...}, "adapter_bytes": <base64>, "adapter_filename": "..."}``.
"""

from __future__ import annotations

import base64
import hashlib
import os
import time
from pathlib import Path
from typing import Any, Callable

import httpx


def _check() -> tuple[str, str]:
    token = os.environ.get("KOLM_RUNPOD_TOKEN")
    endpoint = os.environ.get("KOLM_RUNPOD_ENDPOINT")
    if not token:
        raise RuntimeError("runpod: KOLM_RUNPOD_TOKEN not set. Get one at https://runpod.io/console/user/settings")
    if not endpoint:
        raise RuntimeError("runpod: KOLM_RUNPOD_ENDPOINT not set (endpoint ID of a deployed kolm-trainer worker)")
    return token, endpoint


async def run(job, adapter_dir: Path, on_progress: Callable[[str, int], None]) -> dict[str, Any]:
    token, endpoint = _check()
    base = f"https://api.runpod.ai/v2/{endpoint}"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    spec = {
        "tenant": job.tenant,
        "namespace": job.namespace,
        "base_model": job.base_model,
        "target_size": job.target_size,
        "pair_count": job.pair_count,
        "corpus_url": job.corpus_url,
        "holdout_ratio": job.holdout_ratio,
    }

    started_at = time.time()
    on_progress("runpod:submitting", 5)

    async with httpx.AsyncClient(timeout=60) as client:
        sub = await client.post(f"{base}/run", headers=headers, json={"input": {"spec": spec}})
        if sub.status_code >= 400:
            raise RuntimeError(f"runpod: submit failed ({sub.status_code}): {sub.text[:300]}")
        sub_data = sub.json()
        run_id = sub_data.get("id")
        if not run_id:
            raise RuntimeError(f"runpod: no run id in submit response: {sub_data}")

        on_progress("runpod:running", 20)

        # Poll. RunPod returns status IN_QUEUE → IN_PROGRESS → COMPLETED|FAILED.
        deadline = time.time() + int(os.environ.get("KOLM_RUNPOD_TIMEOUT_SECONDS", "3600"))
        result = None
        while time.time() < deadline:
            await _sleep(5)
            status_resp = await client.get(f"{base}/status/{run_id}", headers=headers)
            if status_resp.status_code >= 400:
                raise RuntimeError(f"runpod: status failed ({status_resp.status_code}): {status_resp.text[:300]}")
            data = status_resp.json()
            state = data.get("status")
            if state == "COMPLETED":
                result = data.get("output")
                break
            if state in {"FAILED", "CANCELLED"}:
                raise RuntimeError(f"runpod: job ended {state}: {data.get('error', 'no error provided')}")
            # Progress signal: COLDSTART → IN_PROGRESS yields a coarse 50%.
            on_progress(f"runpod:{state.lower()}", 50)

    if result is None:
        raise RuntimeError("runpod: poll timed out before completion")

    if not isinstance(result, dict) or "metrics" not in result:
        raise RuntimeError(f"runpod: unexpected result shape: {type(result).__name__}")

    adapter_bytes = base64.b64decode(result.get("adapter_bytes", ""))
    if not adapter_bytes:
        raise RuntimeError("runpod: worker returned no adapter bytes")

    filename = result.get("adapter_filename", f"{job.job_id}.adapter.zip")
    out_path = adapter_dir / filename
    out_path.write_bytes(adapter_bytes)
    sha = hashlib.sha256(adapter_bytes).hexdigest()

    finished_at = time.time()
    on_progress("runpod:complete", 100)

    return {
        "metrics": {**result["metrics"], "backend": "runpod"},
        "adapter": {
            "url": f"file://{out_path.resolve()}",
            "sha256": "sha256-" + sha,
            "size_bytes": len(adapter_bytes),
            "format": result.get("adapter_format", "peft-lora"),
        },
        "compute": {
            "backend": "runpod",
            "device": result.get("device", "runpod-gpu"),
            "cost_usd": result.get("cost_usd"),
            "started_at": started_at,
            "finished_at": finished_at,
            "duration_seconds": round(finished_at - started_at, 3),
            "provenance": {
                "endpoint": endpoint,
                "run_id": run_id,
            },
        },
    }


async def _sleep(seconds: float) -> None:
    import asyncio
    await asyncio.sleep(seconds)
