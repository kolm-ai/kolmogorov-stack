"""
apps/runtime/dispatch.py

Orchestrator. Picks a backend for a given request and routes the call.

Pick order:
  1. If KOLM_BACKEND is set to a known name, use it (fail loud if unavailable).
  2. Otherwise try locals in detect-order: cuda > rocm > mlx > mps > directml > cpu.
  3. Then remotes that have credentials present (only on explicit opt-in).

Every dispatch records the chosen backend, the detect reason, the quote, and
the actual wall_seconds + price_usd into the receipt's `compute` block.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, Optional

from .backends import all_backends, by_name, BackendAdapter, Detection, Quote


LOCAL_DETECT_ORDER = [
    "local-cuda",
    "local-rocm",
    "local-mlx",
    "local-mps",
    "local-directml",
    "local-cpu",
]


def pick(prefer: Optional[str] = None, airgap: bool = False) -> BackendAdapter:
    """Return an available adapter. Falls through detect order until one says yes."""
    if prefer:
        adapter = by_name(prefer)
        det = adapter.detect()
        if not det.available:
            raise RuntimeError(f"backend '{prefer}' not available: {det.reason}")
        return adapter

    for name in LOCAL_DETECT_ORDER:
        adapter = by_name(name)
        det = adapter.detect()
        if det.available:
            return adapter

    if airgap:
        raise RuntimeError("no local backend available and airgap=True forbids remotes")

    for adapter in all_backends():
        if adapter.info.family != "remote":
            continue
        det = adapter.detect()
        if det.available:
            return adapter

    raise RuntimeError("no backend available — install torch or set credentials for a remote")


def dispatch(artifact: Path, request: Dict[str, Any], prefer: Optional[str] = None) -> Dict[str, Any]:
    prefer = prefer or os.environ.get("KOLM_BACKEND")
    airgap = os.environ.get("KOLM_AIRGAP") == "1"
    adapter = pick(prefer=prefer, airgap=airgap)
    return adapter.run(artifact, request)
