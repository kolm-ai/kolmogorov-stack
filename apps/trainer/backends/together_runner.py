"""together: Together AI managed LoRA fine-tune.

Together provides a managed fine-tune endpoint that accepts a JSONL file
and trains a LoRA against a hosted base model. Returns a fine-tune ID we
poll; the resulting adapter is downloaded via Together's file API.

Required env vars:
  KOLM_TOGETHER_TOKEN   : Together API key

Limitations vs the local path:
  * Base model must be one Together hosts (Llama-3.1, Qwen2.5, Mistral, ...)
  * Hyper-parameters (lora_r, lora_alpha) follow Together's defaults unless
    explicitly forwarded.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any, Callable

import httpx


API_BASE = "https://api.together.xyz/v1"


def _check() -> str:
    token = os.environ.get("KOLM_TOGETHER_TOKEN") or os.environ.get("TOGETHER_API_KEY")
    if not token:
        raise RuntimeError("together: KOLM_TOGETHER_TOKEN not set. Get one at https://api.together.xyz/settings/api-keys")
    return token


async def _load_corpus(job) -> list[dict]:
    if not job.corpus_url:
        raise RuntimeError("together: job.corpus_url required (Together accepts JSONL only)")
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.get(job.corpus_url)
        r.raise_for_status()
        lines = [l for l in r.text.splitlines() if l.strip()]
        return [json.loads(l) for l in lines]


async def run(job, adapter_dir: Path, on_progress: Callable[[str, int], None]) -> dict[str, Any]:
    token = _check()
    headers = {"Authorization": f"Bearer {token}"}

    on_progress("together:loading_corpus", 5)
    pairs = await _load_corpus(job)
    if not pairs:
        raise RuntimeError("together: corpus is empty")

    # Together expects a JSONL where each row is a chat-format object.
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8") as fh:
        for p in pairs:
            prompt = p.get("prompt") or p.get("input", "")
            completion = p.get("completion") or p.get("output", "")
            fh.write(json.dumps({"messages": [
                {"role": "user", "content": prompt},
                {"role": "assistant", "content": completion},
            ]}) + "\n")
        corpus_path = fh.name

    started_at = time.time()
    on_progress("together:uploading", 15)

    async with httpx.AsyncClient(timeout=300) as client:
        with open(corpus_path, "rb") as fh:
            up = await client.post(
                f"{API_BASE}/files",
                headers=headers,
                files={"file": (Path(corpus_path).name, fh, "application/json")},
                data={"purpose": "fine-tune"},
            )
        if up.status_code >= 400:
            raise RuntimeError(f"together: file upload failed ({up.status_code}): {up.text[:300]}")
        file_id = up.json().get("id")
        if not file_id:
            raise RuntimeError(f"together: no file id in upload response: {up.json()}")

        on_progress("together:submitting_finetune", 25)
        ft_body = {
            "training_file": file_id,
            "model": job.base_model or "meta-llama/Meta-Llama-3.1-8B-Instruct-Reference",
            "n_epochs": int(os.environ.get("KOLM_TOGETHER_EPOCHS", "3")),
            "lora": True,
            "lora_r": int(os.environ.get("KOLM_TOGETHER_LORA_R", "8")),
            "suffix": (job.namespace or "kolm")[:32],
        }
        ft = await client.post(f"{API_BASE}/fine-tunes", headers={**headers, "Content-Type": "application/json"}, json=ft_body)
        if ft.status_code >= 400:
            raise RuntimeError(f"together: fine-tune submit failed ({ft.status_code}): {ft.text[:300]}")
        job_id = ft.json().get("id")
        if not job_id:
            raise RuntimeError(f"together: no job id in fine-tune response: {ft.json()}")

        on_progress("together:training", 40)
        deadline = time.time() + int(os.environ.get("KOLM_TOGETHER_TIMEOUT_SECONDS", "14400"))
        ft_data = None
        while time.time() < deadline:
            await asyncio.sleep(15)
            ck = await client.get(f"{API_BASE}/fine-tunes/{job_id}", headers=headers)
            if ck.status_code >= 400:
                raise RuntimeError(f"together: poll failed ({ck.status_code}): {ck.text[:300]}")
            ft_data = ck.json()
            status = ft_data.get("status")
            if status == "completed":
                break
            if status in {"failed", "cancelled", "error"}:
                raise RuntimeError(f"together: fine-tune {status}: {ft_data.get('error') or '(no error provided)'}")
            on_progress(f"together:{status}", 60)
        if not ft_data or ft_data.get("status") != "completed":
            raise RuntimeError("together: poll timed out before completion")

        on_progress("together:downloading_adapter", 90)
        output_name = ft_data.get("output_name") or ft_data.get("model_output_name")
        if not output_name:
            raise RuntimeError(f"together: no output_name on completed job: {ft_data}")

        dl = await client.get(f"{API_BASE}/fine-tunes/{job_id}/download", headers=headers)
        if dl.status_code >= 400:
            raise RuntimeError(f"together: adapter download failed ({dl.status_code}): {dl.text[:300]}")
        adapter_bytes = dl.content

    out_path = adapter_dir / f"{job.job_id}.together.zip"
    out_path.write_bytes(adapter_bytes)
    sha = hashlib.sha256(adapter_bytes).hexdigest()
    finished_at = time.time()

    on_progress("together:complete", 100)
    return {
        "metrics": {
            "backend": "together",
            "base_model": ft_body["model"],
            "target_size": job.target_size,
            "pair_count": len(pairs),
            "epochs": ft_body["n_epochs"],
            "together_model_output": output_name,
            "mode": "together-fine-tune",
        },
        "adapter": {
            "url": f"file://{out_path.resolve()}",
            "sha256": "sha256-" + sha,
            "size_bytes": len(adapter_bytes),
            "format": "together-lora",
        },
        "compute": {
            "backend": "together",
            "device": "together-managed",
            "cost_usd": ft_data.get("total_price"),
            "started_at": started_at,
            "finished_at": finished_at,
            "duration_seconds": round(finished_at - started_at, 3),
            "provenance": {
                "together_job_id": job_id,
                "together_file_id": file_id,
                "together_model_output": output_name,
            },
        },
    }
