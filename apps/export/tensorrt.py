"""TensorRT-LLM exporter (NVIDIA serving target).

Pipeline:
    .kolm → unpack → merge LoRA → HF dir → trtllm-build → engine.engine

Toolchain:
    pip install tensorrt_llm  (NVIDIA, requires CUDA 12.x + matching driver)
    trtllm-build CLI on PATH

This is GPU-side serving. If no NVIDIA GPU is present, we fail closed with a
crisp message rather than producing an engine that won't load.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

from .registry import ExportError, ExportNotApplicable, register

NAME = "tensorrt"


def plan(artifact_dir: str | os.PathLike) -> dict:
    artifact_dir = Path(artifact_dir)
    manifest = json.loads((artifact_dir / "manifest.json").read_text(encoding="utf-8"))
    tier = manifest.get("tier") or "recipe"
    return {
        "backend": NAME,
        "tier": tier,
        "applicable": tier != "recipe",
        "steps": ["merge_lora_into_base", "trtllm-build engine"],
        "expected_outputs": ["engine/"],
        "platform_note": "NVIDIA GPU (Ampere or newer recommended)",
    }


def export(artifact_dir: str | os.PathLike, out_dir: str | os.PathLike, **opts) -> dict:
    artifact_dir = Path(artifact_dir)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not plan(artifact_dir)["applicable"]:
        raise ExportNotApplicable("TensorRT export needs lora-tier or higher")

    trtllm = shutil.which("trtllm-build")
    if not trtllm:
        raise ExportError(
            "trtllm-build not on PATH. Install TensorRT-LLM:\n"
            "  pip install tensorrt_llm  (Linux x86_64 + CUDA 12.x only)\n"
            "Or run inside the NVIDIA NGC container nvcr.io/nvidia/tensorrt_llm:latest"
        )

    job_id = json.loads((artifact_dir / "manifest.json").read_text(encoding="utf-8")).get(
        "job_id", "artifact"
    )

    from apps.trainer.merge import merge_lora_to_base

    merged_dir = out_dir / f"{job_id}-merged"
    merged_dir.mkdir(exist_ok=True)
    merge_lora_to_base(
        adapter_dir=str(artifact_dir / "adapter"),
        base_model=opts.get("base_model"),
        out_dir=str(merged_dir),
    )

    engine_dir = out_dir / f"{job_id}-trt"
    cmd = [
        trtllm,
        "--checkpoint_dir", str(merged_dir),
        "--output_dir", str(engine_dir),
        "--gemm_plugin", str(opts.get("gemm_plugin", "auto")),
    ]
    rc = subprocess.run(cmd, check=False).returncode
    if rc != 0:
        raise ExportError(f"trtllm-build exited {rc}")

    return {"backend": NAME, "engine_dir": str(engine_dir), "merged_dir": str(merged_dir)}


register(NAME, export)
