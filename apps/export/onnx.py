"""ONNX exporter (Windows, CPU edge, generic).

Pipeline:
    .kolm → unpack → merge LoRA → optimum-cli export onnx → model.onnx

Toolchain:
    pip install "optimum[exporters]>=1.20"
    pip install onnxruntime
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from .registry import ExportError, ExportNotApplicable, register

NAME = "onnx"


def plan(artifact_dir: str | os.PathLike) -> dict:
    artifact_dir = Path(artifact_dir)
    manifest = json.loads((artifact_dir / "manifest.json").read_text(encoding="utf-8"))
    tier = manifest.get("tier") or "recipe"
    return {
        "backend": NAME,
        "tier": tier,
        "applicable": tier != "recipe",
        "steps": ["merge_lora_into_base", "optimum-cli export onnx"],
        "expected_outputs": ["model.onnx", "tokenizer.json"],
    }


def export(artifact_dir: str | os.PathLike, out_dir: str | os.PathLike, **opts) -> dict:
    artifact_dir = Path(artifact_dir)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not plan(artifact_dir)["applicable"]:
        raise ExportNotApplicable("ONNX export needs lora-tier or higher")

    optimum = shutil.which("optimum-cli")
    if not optimum:
        raise ExportError(
            "optimum-cli not on PATH. Install:\n"
            '  pip install "optimum[exporters]>=1.20" onnxruntime'
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

    onnx_dir = out_dir / f"{job_id}-onnx"
    cmd = [
        optimum, "export", "onnx",
        "--model", str(merged_dir),
        str(onnx_dir),
    ]
    if opts.get("opset"):
        cmd += ["--opset", str(opts["opset"])]
    rc = subprocess.run(cmd, check=False).returncode
    if rc != 0:
        raise ExportError(f"optimum-cli export onnx exited {rc}")

    return {"backend": NAME, "onnx_dir": str(onnx_dir), "merged_dir": str(merged_dir)}


register(NAME, export)
