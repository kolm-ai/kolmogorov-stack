"""Shared stdout/stderr UTF-8 shim for kolm distill Python entry scripts.

Windows consoles default to cp950/cp1252 on many regional installs. Teacher
outputs in this pipeline routinely contain emoji (🙏, ✓, etc.) and CJK
characters. Without this shim, the first `print(teacher_output)` crashes the
process with `UnicodeEncodeError`, which on a long-running trainer destroys
work that took 40+ minutes to produce.

Usage: `from _console import setup_utf8`; call `setup_utf8()` once at import
time in every entry script that may print teacher-sourced strings.

Idempotent — safe to call multiple times. Silent no-op on platforms or Python
versions where `stream.reconfigure` is unavailable (Python < 3.7, certain
pyodide builds).
"""

import sys


def setup_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


setup_utf8()
