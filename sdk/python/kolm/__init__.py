"""
kolm - Python client for the kolm AI compiler.

Wraps the public HTTP API. The CLI (Node) is the canonical interface;
this package mirrors its surface for Python users.

Quick use::

    from kolm import Kolm

    k = Kolm(api_key="k_live_...")

    job = k.compile(
        task="answer support tickets in my voice",
        examples_path="./tickets.jsonl",
        base="qwen2.5-7b-instruct",
    )
    artifact_path = k.wait(job.id)            # downloads .kolm

    out = k.run(artifact_path, input="user can't log in")
    print(out.text)
"""

from .client import Kolm, KolmError, CompileJob, RunResult

__version__ = "0.1.0"
__all__ = ["Kolm", "KolmError", "CompileJob", "RunResult"]
