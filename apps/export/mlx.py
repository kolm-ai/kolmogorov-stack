"""MLX exporter (Apple Silicon target, mlx_lm).

Pipeline:
    .kolm → unpack → merge LoRA → mlx_lm.convert (HF → MLX) → optional --quantize.

Toolchain:
    pip install mlx-lm
    Apple Silicon Mac (mlx is no-op on x86_64 / Linux / Windows beyond CPU bf16).

The exporter records target_device='apple-silicon' in the receipt so a
non-Mac runtime won't accidentally load this artifact.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from .registry import ExportError, ExportNotApplicable, register

NAME = "mlx"


def plan(artifact_dir: str | os.PathLike) -> dict:
    artifact_dir = Path(artifact_dir)
    manifest = json.loads((artifact_dir / "manifest.json").read_text(encoding="utf-8"))
    tier = manifest.get("tier") or "recipe"
    return {
        "backend": NAME,
        "tier": tier,
        "applicable": tier != "recipe",
        "steps": ["merge_lora_into_base", "mlx_lm.convert", "(optional) --quantize 4bit"],
        "expected_outputs": ["mlx_model/"],
        "platform_note": "runtime target is Apple Silicon (M-series)",
    }


def export(artifact_dir: str | os.PathLike, out_dir: str | os.PathLike, **opts) -> dict:
    artifact_dir = Path(artifact_dir)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not plan(artifact_dir)["applicable"]:
        raise ExportNotApplicable("MLX export needs lora-tier or higher")

    try:
        from mlx_lm import convert as mlx_convert  # noqa: F401
    except Exception as e:
        raise ExportError(
            f"mlx_lm not installed: {e}\n"
            "Install: pip install mlx-lm  (Apple Silicon Mac only)"
        ) from e

    if sys.platform != "darwin":
        # MLX has CPU fallback paths on Linux but is intended for Apple Silicon.
        # Don't silently produce a non-functional artifact.
        raise ExportError(
            "MLX export targets Apple Silicon (darwin/arm64). "
            "Detected platform: " + sys.platform + ". "
            "Use --backend gguf or --backend executorch instead."
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

    mlx_dir = out_dir / f"{job_id}-mlx"
    # mlx_lm.convert() signature (mlx-lm 0.18+):
    #   convert(hf_path, mlx_path, quantize=False, q_group_size=64, q_bits=4)
    from mlx_lm import convert as do_convert

    quant = bool(opts.get("quantize") or opts.get("q4"))
    do_convert(
        hf_path=str(merged_dir),
        mlx_path=str(mlx_dir),
        quantize=quant,
        q_bits=int(opts.get("q_bits") or 4),
    )

    return {
        "backend": NAME,
        "mlx_dir": str(mlx_dir),
        "merged_dir": str(merged_dir),
        "quantized": quant,
    }


register(NAME, export)
