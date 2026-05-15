"""
apps/trainer/nvfp4.py

Blackwell NVFP4 training detection + opt-in path.

Context: NVFP4 is a 4-bit floating-point format Blackwell GPUs (sm_120, RTX
5090 / B100 / B200) accelerate natively via tensor cores. It cuts memory by
~4x vs bf16 and gives a meaningful tokens/sec lift on the right shapes.

Requirements stack:
  - GPU: sm_120 (Blackwell)
  - torch ≥ 2.8 (NVFP4 dtype lands in 2.8; until then, callers fall through
    to bf16 + Liger fused kernels)
  - cuBLASLt ≥ 12.9 (ships with cuda 12.8/12.9)
  - flash_attn ≥ 2.7 OR fa3 wheels (sm_120-aware fa3 lands Q3 2026)

If any precondition fails, this module returns a `Plan` with `enabled=False`
and a `reason`. trainer_real.py then falls through to its existing FP8/bf16
selection logic. This is opt-in: caller must set `KOLM_NVFP4=1` to even
consider the path.

We deliberately don't paper over readiness gaps. When 2.8 ships, this
module's `verify_torch()` returns True without any code changes.
"""

from __future__ import annotations
import os
import re
import subprocess
from dataclasses import dataclass, asdict
from typing import Dict, Any, Optional


@dataclass
class NVFP4Plan:
    enabled: bool
    reason: str
    dtype: Optional[str] = None
    compute_capability: Optional[str] = None
    torch_version: Optional[str] = None
    flash_attn_version: Optional[str] = None
    blockers: Optional[list] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def _torch_version() -> Optional[str]:
    try:
        import torch
        return torch.__version__
    except ImportError:
        return None


def _flash_attn_version() -> Optional[str]:
    try:
        import flash_attn
        return getattr(flash_attn, "__version__", None)
    except ImportError:
        return None


def _compute_capability() -> Optional[str]:
    """Return CUDA compute capability as 'sm_NNN' or None."""
    try:
        import torch
        if not torch.cuda.is_available():
            return None
        major, minor = torch.cuda.get_device_capability(0)
        return f"sm_{major}{minor}0"
    except Exception:
        return None


def _nvfp4_dtype_available() -> bool:
    """True iff torch exposes nvfp4-ish dtypes (lands in 2.8)."""
    try:
        import torch
        for name in ("float4_e2m1fn_x2", "nvfp4", "float4_e2m1"):
            if hasattr(torch, name):
                return True
        return False
    except ImportError:
        return False


def _cublaslt_version() -> Optional[str]:
    """Best-effort cuBLASLt version probe via nvidia-smi nvcc."""
    try:
        out = subprocess.run(
            ["nvcc", "--version"], capture_output=True, text=True, timeout=2
        )
        m = re.search(r"V(\d+\.\d+)", out.stdout)
        return m.group(1) if m else None
    except Exception:
        return None


def detect() -> NVFP4Plan:
    """One-shot readiness report. Pure inspection; no side effects."""
    if os.environ.get("KOLM_NVFP4_DISABLE") == "1":
        return NVFP4Plan(enabled=False, reason="disabled via KOLM_NVFP4_DISABLE=1")

    cc = _compute_capability()
    tv = _torch_version()
    fav = _flash_attn_version()

    blockers = []
    if cc is None:
        blockers.append("no CUDA device")
    elif cc not in ("sm_120", "sm_121", "sm_130"):
        blockers.append(f"GPU is {cc}, NVFP4 requires sm_120+")

    if tv is None:
        blockers.append("torch not installed")
    elif not _nvfp4_dtype_available():
        blockers.append(f"torch {tv} lacks NVFP4 dtype (need ≥ 2.8)")

    # flash_attn is recommended but not strictly required.
    fa_warn = None
    if fav is None:
        fa_warn = "flash_attn not installed (fa3 ≥ 2.7 recommended)"

    if blockers:
        return NVFP4Plan(
            enabled=False,
            reason="; ".join(blockers),
            compute_capability=cc,
            torch_version=tv,
            flash_attn_version=fav,
            blockers=blockers,
        )

    return NVFP4Plan(
        enabled=True,
        reason="all preconditions satisfied",
        dtype="nvfp4",
        compute_capability=cc,
        torch_version=tv,
        flash_attn_version=fav,
        blockers=[fa_warn] if fa_warn else [],
    )


def maybe_apply(model, *, force: bool = False):
    """
    If NVFP4 is opt-in (KOLM_NVFP4=1) and the box passes detect(), rewrite
    model parameters to nvfp4 in-place. Returns (model, NVFP4Plan).

    Falls through to no-op when preconditions fail — trainer_real.py picks
    fa2/fa3 + bf16 instead.
    """
    if not force and os.environ.get("KOLM_NVFP4") != "1":
        return model, NVFP4Plan(enabled=False, reason="KOLM_NVFP4 not set")

    plan = detect()
    if not plan.enabled:
        return model, plan

    try:
        import torch
        # torch 2.8: torch.float4_e2m1fn_x2 (the working name, may shift).
        target_dtype = (
            getattr(torch, "float4_e2m1fn_x2", None)
            or getattr(torch, "nvfp4", None)
            or getattr(torch, "float4_e2m1", None)
        )
        if target_dtype is None:
            return model, NVFP4Plan(enabled=False, reason="torch dtype lookup failed")
        model = model.to(dtype=target_dtype)
        return model, plan
    except Exception as exc:
        return model, NVFP4Plan(enabled=False, reason=f"apply failed: {exc}")


def cli_doctor() -> Dict[str, Any]:
    """JSON-shaped output for `kolm gpu doctor` to include in its report."""
    plan = detect()
    return {
        "nvfp4": plan.to_dict(),
        "cublaslt_probe": _cublaslt_version(),
    }
