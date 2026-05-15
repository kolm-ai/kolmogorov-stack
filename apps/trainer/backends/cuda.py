"""local-cuda backend wrapper. Dispatches to trainer_real (Unsloth path).

Falls back with a clear error if CUDA wheels are missing: never silently
downgrades. The caller (trainer/main.py) decides whether to retry on
``local-cpu`` instead.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Callable


async def run(job, adapter_dir: Path, on_progress: Callable[[str, int], None]) -> dict[str, Any]:
    try:
        from ..trainer_real import run_real_training
    except ImportError as err:
        raise RuntimeError(
            "local-cuda: trainer_real not importable. "
            "Install with `uv pip install -e .[cuda]` or set KOLM_TRAINER_BACKEND=local-cpu."
        ) from err

    started_at = time.time()
    result = await run_real_training(job, adapter_dir, on_progress)
    finished_at = time.time()

    result.setdefault("compute", {})
    result["compute"].update({
        "backend": "local-cuda",
        "device": result.get("metrics", {}).get("device", "cuda:0"),
        "cost_usd": 0.0,
        "started_at": started_at,
        "finished_at": finished_at,
        "duration_seconds": round(finished_at - started_at, 3),
    })
    return result
