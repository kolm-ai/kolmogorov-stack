"""Exporter registry + base error types.

Keep the import surface flat — `from apps.export import get_exporter` —
so the CLI can resolve `--backend <name>` to a runner without knowing the
module layout.
"""

from __future__ import annotations

from typing import Callable, Dict


class ExportError(RuntimeError):
    """Generic exporter failure (missing tool, malformed artifact, conversion failed)."""


class ExportNotApplicable(ExportError):
    """The artifact tier does not support this backend (e.g., recipe-only into GGUF)."""


# Filled below by each backend module's `register()` call. Late-imported so a
# missing optional dep (mlx_lm, executorch, etc.) only fails when that backend
# is asked for, not at module load.
EXPORTERS: Dict[str, Callable[..., dict]] = {}


def register(name: str, runner: Callable[..., dict]) -> None:
    EXPORTERS[name] = runner


def get_exporter(name: str) -> Callable[..., dict]:
    name = (name or "").strip().lower()
    if name not in EXPORTERS:
        raise ExportError(
            f"unknown backend: {name!r}. known: {sorted(EXPORTERS)}"
        )
    return EXPORTERS[name]


# Register backends. Each module is import-cheap; the heavy toolchain check
# happens when the runner is called, not when the module loads.
from . import gguf, mlx, executorch, tensorrt, coreml, onnx  # noqa: E402,F401
