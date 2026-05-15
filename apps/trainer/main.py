"""Kolm trainer bridge.

FastAPI service that receives distill jobs from kolm.ai
(POST /v1/specialists/auto-distill on the kolm.ai side), runs an Unsloth+PEFT
QLoRA training pass against the corpus, evaluates on a held-out split, and
POSTs the resulting metrics + adapter URL back to the callback_url.

Three modes (set via KOLM_TRAINER_MODE env var):
  * mock  — no model deps; synthesizes a plausible metrics envelope so the
            distill flow can be tested end-to-end on commodity hardware. Default.
  * local — real PEFT LoRA training on CPU or MPS, no CUDA required. Uses
            stock transformers + peft. Default base is a tiny GPT-2 stub so
            the pipeline runs in seconds; pass any HF causal LM via base_model.
  * real  — auto-picks the fastest available backend: Unsloth + bitsandbytes
            on CUDA, else the local CPU/MPS path. Set KOLM_TRAINER_BACKEND
            (unsloth | local) to force a specific backend.

Job lifecycle:
  1. POST /distill {tenant, namespace, base_model, target_size, pair_count,
     callback_url, corpus_url?, holdout_ratio?}
     → returns {job_id, status: 'queued', status_url}
  2. Trainer runs the job asynchronously, posts intermediate status updates
     to status_url.
  3. When done, trainer POSTs {job_id, status: 'completed', metrics, adapter:
     {url, sha256, size_bytes}} to callback_url. Authorization header is the
     trainer's bridge token; kolm.ai verifies before merging.

Persistence: jobs live in ./trainer-jobs.jsonl (append-only). Each line is one
job snapshot; the latest snapshot for a job_id is the truth. Restart-safe.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

JOBS_PATH = Path(os.environ.get("KOLM_TRAINER_JOBS", "trainer-jobs.jsonl"))
BRIDGE_TOKEN = os.environ.get("KOLM_TRAINER_BRIDGE_TOKEN", "")
MODE = os.environ.get("KOLM_TRAINER_MODE", "mock").lower()
BACKEND = os.environ.get("KOLM_TRAINER_BACKEND", "auto").lower()
ADAPTER_DIR = Path(os.environ.get("KOLM_TRAINER_ADAPTER_DIR", "./adapters"))
ADAPTER_DIR.mkdir(parents=True, exist_ok=True)


def _cuda_available() -> bool:
    try:
        import torch  # noqa: WPS433
        return torch.cuda.is_available()
    except Exception:  # noqa: BLE001
        return False


class DistillRequest(BaseModel):
    tenant: str
    namespace: str = "default"
    base_model: str = "Qwen/Qwen2.5-3B-Instruct"
    target_size: str = Field("3b", pattern=r"^(0\.5b|1\.5b|3b|7b)$")
    pair_count: int = Field(0, ge=0)
    callback_url: str
    corpus_url: Optional[str] = None
    holdout_ratio: float = Field(0.1, ge=0.0, le=0.5)


class JobStatus(BaseModel):
    job_id: str
    status: str
    progress: int = 0
    stage: Optional[str] = None
    error: Optional[str] = None


@dataclass
class Job:
    job_id: str
    tenant: str
    namespace: str
    base_model: str
    target_size: str
    pair_count: int
    callback_url: str
    corpus_url: Optional[str]
    holdout_ratio: float
    status: str = "queued"
    progress: int = 0
    stage: Optional[str] = None
    stages: list[dict[str, Any]] = field(default_factory=list)
    metrics: Optional[dict[str, Any]] = None
    adapter: Optional[dict[str, Any]] = None
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)


_jobs: dict[str, Job] = {}


def _persist(job: Job) -> None:
    job.updated_at = time.time()
    with JOBS_PATH.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(asdict(job)) + "\n")


def _load_existing() -> None:
    """Reload latest snapshot per job from JOBS_PATH on startup."""
    if not JOBS_PATH.exists():
        return
    for line in JOBS_PATH.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            data = json.loads(line)
            _jobs[data["job_id"]] = Job(**data)
        except (ValueError, TypeError, KeyError):
            continue


def _new_job_id() -> str:
    return "td_" + secrets.token_hex(6)


def _check_bridge_auth(request: Request) -> None:
    if not BRIDGE_TOKEN:
        return  # local dev convenience — set the env var in prod
    expected = f"Bearer {BRIDGE_TOKEN}"
    got = request.headers.get("authorization", "")
    if got != expected:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid bridge token")


async def _post_status(callback_url: str, payload: dict[str, Any]) -> None:
    """Fire-and-forget status POST. Failures are logged, not surfaced."""
    headers = {"content-type": "application/json"}
    if BRIDGE_TOKEN:
        headers["authorization"] = f"Bearer {BRIDGE_TOKEN}"
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            await client.post(callback_url, headers=headers, json=payload)
        except httpx.HTTPError:
            pass


async def _run_mock(job: Job) -> None:
    """Synthesize a plausible training trajectory without touching a GPU."""
    stages = [
        ("loading_corpus", 10),
        ("synthesizing_pairs", 25),
        ("training", 70),
        ("evaluating", 90),
        ("packaging_adapter", 100),
    ]
    for stage, pct in stages:
        job.stage = stage
        job.progress = pct
        job.stages.append({"name": stage, "at": time.time(), "progress": pct})
        _persist(job)
        await _post_status(job.callback_url, {
            "job_id": job.job_id,
            "status": "running",
            "stage": stage,
            "progress": pct,
        })
        await asyncio.sleep(0.4)

    pair_floor = max(job.pair_count, 16)
    # Plausible mock numbers grounded by pair count and target size.
    base_acc = 0.78 + min(0.15, pair_floor / 4000)
    size_bias = {"0.5b": -0.03, "1.5b": -0.01, "3b": 0.0, "7b": 0.02}[job.target_size]
    held_out_acc = max(0.0, min(1.0, base_acc + size_bias))

    adapter_path = ADAPTER_DIR / f"{job.job_id}.adapter.safetensors"
    adapter_path.write_bytes(b"KOLM_MOCK_ADAPTER_v1\n" + job.job_id.encode("utf-8"))
    adapter_sha = "sha256-mock-" + secrets.token_hex(16)

    job.status = "completed"
    job.progress = 100
    job.stage = "completed"
    job.metrics = {
        "pair_count": pair_floor,
        "holdout_pair_count": int(pair_floor * job.holdout_ratio),
        "holdout_accuracy": round(held_out_acc, 4),
        "holdout_f1": round(held_out_acc * 0.98, 4),
        "training_loss_final": round(0.4 - 0.3 * held_out_acc, 4),
        "epochs": 3,
        "steps": pair_floor * 3,
        "base_model": job.base_model,
        "target_size": job.target_size,
        "mode": "mock",
    }
    job.adapter = {
        "url": f"file://{adapter_path.resolve()}",
        "sha256": adapter_sha,
        "size_bytes": adapter_path.stat().st_size,
        "format": "peft-lora",
    }
    _persist(job)
    await _post_status(job.callback_url, {
        "job_id": job.job_id,
        "status": "completed",
        "metrics": job.metrics,
        "adapter": job.adapter,
    })


def _pick_backend() -> str:
    """Resolve the runtime backend for the real path.

    KOLM_TRAINER_BACKEND overrides the auto-pick. Accepts canonical names
    from src/compute/registry.json (local-cpu, local-cuda, local-mps,
    local-mlx, modal, runpod, together, vast, lambda, replicate, remote-ssh)
    plus legacy aliases (unsloth → local-cuda, local → local-cpu).

      * ``auto`` (default) — pick local-cuda when CUDA available, else local-cpu.
      * any registry name — use that backend; never silently downgrades to mock.
    """
    if BACKEND == "auto" or BACKEND == "":
        return "local-cuda" if _cuda_available() else "local-cpu"
    return BACKEND


async def _run_real(job: Job) -> None:
    """Real training. Dispatches via backends.get_runner so every Tier-1
    backend (local CPU/GPU/MPS, Modal, RunPod, Together, Vast, Lambda,
    Replicate, remote-SSH) flows through one code path. Provenance lands
    in metrics + the compute block of the result."""
    requested = _pick_backend()
    try:
        from .backends import get_runner, canonicalize
        backend = canonicalize(requested)
    except Exception as err:  # noqa: BLE001
        job.status = "failed"
        job.error = f"unknown backend `{requested}`: {err}"
        _persist(job)
        await _post_status(job.callback_url, {
            "job_id": job.job_id,
            "status": "failed",
            "error": job.error,
        })
        return

    job.stage = f"backend:{backend}"
    _persist(job)

    try:
        runner = await get_runner(backend)
        result = await runner(job, ADAPTER_DIR, on_progress=lambda stage, pct: _persist_progress(job, stage, pct))
        result["metrics"]["backend"] = backend
        job.status = "completed"
        job.metrics = result["metrics"]
        job.adapter = result["adapter"]
        # Persist the compute provenance block alongside metrics so the
        # callback can fold it into the artifact receipt.
        if "compute" in result:
            job.metrics["compute"] = result["compute"]
        _persist(job)
        await _post_status(job.callback_url, {
            "job_id": job.job_id,
            "status": "completed",
            "metrics": job.metrics,
            "adapter": job.adapter,
        })
    except Exception as err:  # noqa: BLE001
        job.status = "failed"
        job.error = f"{backend}: {err}"
        _persist(job)
        await _post_status(job.callback_url, {
            "job_id": job.job_id,
            "status": "failed",
            "error": job.error,
        })


def _persist_progress(job: Job, stage: str, pct: int) -> None:
    job.stage = stage
    job.progress = pct
    job.stages.append({"name": stage, "at": time.time(), "progress": pct})
    _persist(job)


async def _run_job(job: Job) -> None:
    job.status = "running"
    _persist(job)
    if MODE == "real":
        await _run_real(job)
    else:
        await _run_mock(job)


app = FastAPI(title="Kolm trainer bridge", version="0.1.0")


@app.on_event("startup")
async def _startup() -> None:
    _load_existing()


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "mode": MODE,
        "backend": _pick_backend() if MODE == "real" else None,
        "cuda": _cuda_available(),
        "bridge_auth": bool(BRIDGE_TOKEN),
        "jobs_in_memory": len(_jobs),
        "version": "0.2.0",
    }


@app.post("/distill")
async def distill(req: DistillRequest, request: Request) -> JSONResponse:
    _check_bridge_auth(request)
    job_id = _new_job_id()
    job = Job(
        job_id=job_id,
        tenant=req.tenant,
        namespace=req.namespace,
        base_model=req.base_model,
        target_size=req.target_size,
        pair_count=req.pair_count,
        callback_url=req.callback_url,
        corpus_url=req.corpus_url,
        holdout_ratio=req.holdout_ratio,
    )
    _jobs[job_id] = job
    _persist(job)
    asyncio.create_task(_run_job(job))
    return JSONResponse({
        "job_id": job_id,
        "status": "queued",
        "status_url": f"/jobs/{job_id}",
    }, status_code=status.HTTP_202_ACCEPTED)


@app.get("/jobs/{job_id}")
async def get_job(job_id: str, request: Request) -> JobStatus:
    _check_bridge_auth(request)
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return JobStatus(
        job_id=job.job_id,
        status=job.status,
        progress=job.progress,
        stage=job.stage,
        error=job.error,
    )


@app.get("/")
async def index() -> dict[str, Any]:
    return {
        "service": "kolm-trainer",
        "version": "0.1.0",
        "endpoints": ["GET /health", "POST /distill", "GET /jobs/{job_id}"],
        "mode": MODE,
    }
