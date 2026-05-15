"""Trainer backend dispatch.

Translates ``KOLM_TRAINER_BACKEND`` (or the per-job override) into the right
runner. Every backend exposes the same coroutine signature:

    async def run(job, adapter_dir: Path, on_progress: Callable[[str, int], None]) -> dict:
        return {"metrics": {...}, "adapter": {...}, "compute": {...}}

Day 1 backends with real implementations:
  * ``local`` / ``local-cpu`` / ``local-mps``: torch CPU/MPS via trainer_local.py
  * ``local-cuda`` / ``unsloth``              : Unsloth/PEFT via trainer_real.py
  * ``remote-ssh``                             : SSH to a user-supplied box

Day 1 scaffolds (raise a clear error until an SDK + auth are configured):
  * ``modal``, ``runpod``, ``together``, ``vast``, ``lambda``, ``replicate``

The registry auto-pick mirrors src/compute/index.js: same scoring formula,
same constraints. Receipts that come out of any backend carry a ``compute``
provenance block so a downstream verifier can see exactly which target
built the artifact.
"""

from __future__ import annotations

import os
from typing import Callable

# Backend canonical names: match src/compute/registry.json.
TIER_1 = {"local-cpu", "local-cuda", "local-mps", "modal", "runpod", "together", "vast", "remote-ssh"}
TIER_2 = {"local-mlx", "local-rocm", "local-directml", "lambda", "replicate", "fal"}
ALL = TIER_1 | TIER_2 | {"local", "unsloth"}  # legacy aliases

# Aliases the dispatch accepts. "local" === "local-cpu" (or local-mps if available);
# "unsloth" === "local-cuda".
_ALIASES = {
    "local": "local-cpu",
    "unsloth": "local-cuda",
    "cuda": "local-cuda",
    "mps": "local-mps",
    "cpu": "local-cpu",
    "mlx": "local-mlx",
    "rocm": "local-rocm",
    "directml": "local-directml",
}


def canonicalize(name: str | None) -> str:
    """Resolve aliases. Returns the registry name or raises ValueError."""
    if not name:
        return "local-cpu"
    n = name.strip().lower()
    n = _ALIASES.get(n, n)
    if n not in ALL:
        raise ValueError(f"unknown backend: {name}; known: {sorted(ALL)}")
    return n


async def get_runner(name: str) -> Callable:
    """Import and return the run() coroutine for the named backend.

    Local backends are kept in a single module (local.py) that picks the
    correct device. Cloud backends each get their own module so SDK imports
    are isolated.
    """
    n = canonicalize(name)
    if n in {"local-cpu", "local-mps"}:
        from .local import run as runner
        # local.run respects KOLM_FORCE_DEVICE so it can be steered.
        os.environ["KOLM_FORCE_DEVICE"] = n.replace("local-", "")
        return runner
    if n == "local-mlx":
        from .mlx import run as runner
        return runner
    if n == "local-rocm":
        from .rocm import run as runner
        return runner
    if n == "local-directml":
        from .directml import run as runner
        return runner
    if n == "local-cuda":
        from .cuda import run as runner
        return runner
    if n == "modal":
        from .modal_runner import run as runner
        return runner
    if n == "runpod":
        from .runpod_runner import run as runner
        return runner
    if n == "together":
        from .together_runner import run as runner
        return runner
    if n == "vast":
        from .vast_runner import run as runner
        return runner
    if n == "lambda":
        from .lambda_runner import run as runner
        return runner
    if n == "replicate":
        from .replicate_runner import run as runner
        return runner
    if n == "remote-ssh":
        from .remote_ssh import run as runner
        return runner
    if n == "fal":
        # fal is inference-only: runner raises a clear error if called for training.
        from .fal_runner import run as runner
        return runner
    raise ValueError(f"no runner for backend: {n}")
