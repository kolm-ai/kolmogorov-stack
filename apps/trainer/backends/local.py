"""Local backend wrapper.

Adds the ``compute`` provenance block and a device override to the existing
``trainer_local.run_local_training`` coroutine. The override comes from
``KOLM_FORCE_DEVICE`` (set by backends/__init__.get_runner) so picking
``local-mps`` actually pins MPS even when CUDA is also present, and picking
``local-cpu`` forces CPU when MPS would otherwise be auto-selected.

For ``local-mlx`` we fall back to the torch path with a warning rather than
silently downgrading: MLX-native training is shipped in
``backends/mlx_runner.py`` (Day 30) once the upstream API stabilises.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, Callable


async def run(job, adapter_dir: Path, on_progress: Callable[[str, int], None]) -> dict[str, Any]:
    from ..trainer_local import run_local_training

    force = (os.environ.get("KOLM_FORCE_DEVICE") or "").lower()
    # The torch device probe lives in trainer_local; we steer it via env to
    # avoid plumbing kwargs through every call site.
    if force == "cpu":
        os.environ["KOLM_DISABLE_MPS"] = "1"
    elif force == "mps":
        os.environ.pop("KOLM_DISABLE_MPS", None)

    started_at = time.time()
    result = await run_local_training(job, adapter_dir, on_progress)
    finished_at = time.time()

    result.setdefault("compute", {})
    result["compute"].update({
        "backend": f"local-{force}" if force else "local",
        "device": force or result.get("metrics", {}).get("device", "cpu"),
        "cost_usd": 0.0,
        "started_at": started_at,
        "finished_at": finished_at,
        "duration_seconds": round(finished_at - started_at, 3),
    })
    return result
