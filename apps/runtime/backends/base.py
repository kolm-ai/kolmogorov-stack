"""
apps/runtime/backends/base.py

BackendAdapter contract for compute backends. Every backend (local CPU, CUDA,
MPS, MLX, ROCm, DirectML; remote Modal, RunPod, Together, Vast, Lambda Cloud,
Replicate, fal, SSH) implements the same four-method lifecycle:

    detect() -> Detection
        Cheap, no side effects. Used by `kolm compute list` to render
        availability state. Must NOT make network calls or import heavy modules.

    quote(artifact, tokens) -> Quote
        Pre-flight estimate. Returns price_usd + wall_seconds + cold_start_seconds
        for running `tokens` generations against `artifact` on this backend.
        Quotes are advisory; actual cost is recorded in the receipt.

    run(artifact, request) -> dict
        Boots the artifact (or attaches to a warm worker), runs the OpenAI-
        compatible request, returns the response. May invoke teardown on its
        own for one-shot backends.

    teardown() -> None
        Release resources. MUST be idempotent.

Adapters are pure value carriers. The CLI / server picks the adapter, invokes
detect to filter, calls quote for the user, then run for the actual workload.
Receipts record which adapter ran + cost + wall time.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional


@dataclass
class Detection:
    available: bool
    reason: str
    version: Optional[str] = None
    device_name: Optional[str] = None


@dataclass
class Quote:
    price_usd: float
    wall_seconds: float
    cold_start_seconds: float = 0.0
    notes: str = ""

    @property
    def total_seconds(self) -> float:
        return self.wall_seconds + self.cold_start_seconds


@dataclass
class BackendInfo:
    """Static metadata about a backend, surfaced by `kolm compute list`."""

    name: str
    family: str
    description: str
    requires_env: list = field(default_factory=list)
    requires_pip: list = field(default_factory=list)
    docs_url: Optional[str] = None


class BackendAdapter:
    info: BackendInfo

    def detect(self) -> Detection:
        raise NotImplementedError

    def quote(self, artifact: Path, tokens: int = 1024) -> Quote:
        raise NotImplementedError

    def run(self, artifact: Path, request: Dict[str, Any]) -> Dict[str, Any]:
        raise NotImplementedError

    def teardown(self) -> None:
        return None


def _env_missing(keys) -> Optional[str]:
    import os

    missing = [k for k in keys if not os.environ.get(k)]
    if missing:
        return "missing env: " + ", ".join(missing)
    return None
