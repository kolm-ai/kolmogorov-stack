"""fal: fal.ai serverless. Inference-only backend.

Listed in src/compute/registry.json with ``train: false`` because fal does
not expose a fine-tuning surface. This module exists so the dispatcher can
canonicalize ``fal`` and surface a precise error to the caller instead of
``unknown backend: fal``.

If you need training on a managed serverless target, pick ``modal``,
``replicate``, or ``together``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable


async def run(job, adapter_dir: Path, on_progress: Callable[[str, int], None]) -> dict[str, Any]:
    raise RuntimeError(
        "fal: inference-only backend; training is not supported. "
        "Pick `modal`, `replicate`, `together`, or a `local-*` backend for fine-tunes. "
        "See https://fal.ai/docs for the fal inference surface."
    )
