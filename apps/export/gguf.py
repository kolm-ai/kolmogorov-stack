"""GGUF exporter (llama.cpp / Ollama / LM Studio target).

Pipeline:
    .kolm → unpack → check tier ≥ lora → merge LoRA into base weights (peft) →
    convert HF dir → GGUF via llama.cpp/convert-hf-to-gguf.py →
    optional `llama-quantize` to Q4_K_M / Q5_K_M / Q8_0.

Toolchain expected on PATH:
    python ≥ 3.10 with `transformers`, `peft`, `safetensors`
    `convert-hf-to-gguf.py` from a checked-out llama.cpp repo (or shipped via pip
        in `gguf` package — we try both)
    `llama-quantize` (optional, only when --quant is set)

This module never lies about success. If the toolchain isn't found, we raise
ExportError with the exact pip / git clone line a buyer needs to run.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional

from .registry import ExportError, ExportNotApplicable, register

NAME = "gguf"
ALLOWED_QUANT = {"f16", "bf16", "f32", "q4_k_m", "q5_k_m", "q8_0"}


def plan(artifact_dir: str | os.PathLike) -> dict:
    """Inspect an unpacked .kolm dir. Return what we'd do if asked to export."""
    artifact_dir = Path(artifact_dir)
    manifest_path = artifact_dir / "manifest.json"
    if not manifest_path.exists():
        raise ExportError(f"no manifest.json under {artifact_dir}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    tier = manifest.get("tier") or "recipe"
    return {
        "backend": NAME,
        "tier": tier,
        "applicable": tier != "recipe",
        "steps": [
            "merge_lora_into_base",
            "convert_hf_to_gguf",
            "(optional) llama-quantize",
        ],
        "expected_outputs": [f"{manifest.get('job_id', 'artifact')}.gguf"],
    }


def _find_convert_script() -> Optional[str]:
    """Locate convert-hf-to-gguf.py from a llama.cpp checkout (or pip-installed gguf)."""
    for env_key in ("LLAMA_CPP_CONVERT", "KOLM_LLAMA_CONVERT"):
        candidate = os.environ.get(env_key)
        if candidate and Path(candidate).is_file():
            return candidate
    # Try a typical sibling repo layout.
    for guess in [
        Path("third_party/llama.cpp/convert-hf-to-gguf.py"),
        Path.home() / "llama.cpp" / "convert-hf-to-gguf.py",
        Path.home() / "src" / "llama.cpp" / "convert-hf-to-gguf.py",
    ]:
        if guess.is_file():
            return str(guess)
    # Pip-installed `gguf` ships a CLI entry-point as `gguf-convert` since 0.10.
    if shutil.which("gguf-convert"):
        return "gguf-convert"
    return None


def export(artifact_dir: str | os.PathLike, out_dir: str | os.PathLike, **opts) -> dict:
    artifact_dir = Path(artifact_dir)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    p = plan(artifact_dir)
    if not p["applicable"]:
        raise ExportNotApplicable(
            "this artifact is recipe-tier (v0.1 default). "
            "GGUF export needs the lora tier or higher. "
            "Recompile with `--preset lora-fast` or `--preset sft`."
        )

    convert = _find_convert_script()
    if not convert:
        raise ExportError(
            "llama.cpp converter not found. "
            "Install one of:\n"
            "  pip install gguf  (provides `gguf-convert`)\n"
            "  git clone https://github.com/ggerganov/llama.cpp ~/llama.cpp\n"
            "Then re-run, or set LLAMA_CPP_CONVERT=/path/to/convert-hf-to-gguf.py"
        )

    job_id = json.loads((artifact_dir / "manifest.json").read_text(encoding="utf-8")).get(
        "job_id", "artifact"
    )

    # Step 1: merge LoRA into base. Delegates to apps.trainer.backends.local
    # which has the canonical merge path.
    merged_dir = out_dir / f"{job_id}-merged"
    merged_dir.mkdir(exist_ok=True)
    try:
        from apps.trainer.merge import merge_lora_to_base  # late import, optional dep
    except Exception as e:
        raise ExportError(
            f"merge step failed to import: {e}. "
            "install: pip install transformers peft safetensors"
        ) from e
    merge_lora_to_base(
        adapter_dir=str(artifact_dir / "adapter"),
        base_model=opts.get("base_model"),
        out_dir=str(merged_dir),
    )

    # Step 2: HF → GGUF.
    gguf_path = out_dir / f"{job_id}.gguf"
    cmd = [
        sys.executable,
        convert,
        str(merged_dir),
        "--outfile",
        str(gguf_path),
        "--outtype",
        opts.get("dtype", "f16"),
    ]
    rc = subprocess.run(cmd, check=False).returncode
    if rc != 0:
        raise ExportError(f"convert-hf-to-gguf exited {rc}")

    # Step 3: optional quantize.
    quant = (opts.get("quant") or "").lower()
    quantized_path = None
    if quant:
        if quant not in ALLOWED_QUANT:
            raise ExportError(f"quant must be one of {sorted(ALLOWED_QUANT)}; got {quant!r}")
        if quant in {"f16", "bf16", "f32"}:
            # already at this precision from convert step
            pass
        else:
            llq = shutil.which("llama-quantize") or shutil.which("quantize")
            if not llq:
                raise ExportError(
                    "llama-quantize not on PATH. Build llama.cpp or skip --quant."
                )
            quantized_path = out_dir / f"{job_id}.{quant}.gguf"
            qcmd = [llq, str(gguf_path), str(quantized_path), quant.upper()]
            rc = subprocess.run(qcmd, check=False).returncode
            if rc != 0:
                raise ExportError(f"llama-quantize exited {rc}")

    return {
        "backend": NAME,
        "gguf": str(gguf_path),
        "quantized": str(quantized_path) if quantized_path else None,
        "merged_dir": str(merged_dir),
    }


register(NAME, export)
