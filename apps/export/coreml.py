"""Core ML exporter (iOS / iPadOS / macOS native via Apple Neural Engine).

Pipeline:
    .kolm → unpack → merge LoRA → torch → coremltools.convert (.mlpackage)

Toolchain:
    pip install coremltools  (Apple Silicon Mac strongly recommended)
    pip install torch
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from .registry import ExportError, ExportNotApplicable, register

NAME = "coreml"


def plan(artifact_dir: str | os.PathLike) -> dict:
    artifact_dir = Path(artifact_dir)
    manifest = json.loads((artifact_dir / "manifest.json").read_text(encoding="utf-8"))
    tier = manifest.get("tier") or "recipe"
    return {
        "backend": NAME,
        "tier": tier,
        "applicable": tier != "recipe",
        "steps": ["merge_lora_into_base", "coremltools.convert"],
        "expected_outputs": ["model.mlpackage"],
        "platform_note": "iOS 17+ / macOS 14+ runtime; export tooling needs Apple Silicon",
    }


def export(artifact_dir: str | os.PathLike, out_dir: str | os.PathLike, **opts) -> dict:
    artifact_dir = Path(artifact_dir)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not plan(artifact_dir)["applicable"]:
        raise ExportNotApplicable("Core ML export needs lora-tier or higher")

    try:
        import coremltools as ct  # noqa: F401
    except Exception as e:
        raise ExportError(
            f"coremltools not installed: {e}\n"
            "Install: pip install coremltools\n"
            "Apple Silicon Mac strongly recommended."
        ) from e

    if sys.platform != "darwin":
        raise ExportError(
            "Core ML conversion is reliable only on macOS. Detected: " + sys.platform
        )

    raise ExportError(
        "Core ML export needs a model-family-specific wrapper. "
        "Today supported via this pipeline: mlx (Apple Silicon native), "
        "gguf (cross-platform). File a feature request with your base_model."
    )


register(NAME, export)
