"""modal: serverless GPU on modal.com.

Day 1 contract: KOLM_MODAL_TOKEN_ID + KOLM_MODAL_TOKEN_SECRET + a deployed
modal app named ``kolm-trainer`` exposing a function ``train_lora(spec)``
must exist. The runner uploads the corpus, invokes the function, polls for
the adapter, downloads it, and reports metrics+adapter shapes identical to
the local path.

If the modal SDK or auth is missing, the runner raises ``RuntimeError``
with the exact missing piece: the dispatch layer can then surface that
to the caller (kolm.ai) instead of silently downgrading.

See: https://modal.com/docs/guide  (Modal Functions, Volumes, GPU types)
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Callable


REQUIRED_VARS = ("KOLM_MODAL_TOKEN_ID", "KOLM_MODAL_TOKEN_SECRET")
APP_NAME = os.environ.get("KOLM_MODAL_APP", "kolm-trainer")
FUNCTION_NAME = os.environ.get("KOLM_MODAL_FN", "train_lora")


def _check_auth() -> None:
    missing = [v for v in REQUIRED_VARS if not os.environ.get(v)]
    if missing:
        raise RuntimeError(
            f"modal: missing env vars: {missing}. "
            f"Get a token at https://modal.com/settings/tokens and set both."
        )


def _load_sdk():
    try:
        import modal  # noqa: WPS433
        return modal
    except ImportError as err:
        raise RuntimeError(
            "modal: SDK not installed. Install with `uv pip install modal`."
        ) from err


async def run(job, adapter_dir: Path, on_progress: Callable[[str, int], None]) -> dict[str, Any]:
    _check_auth()
    modal = _load_sdk()

    on_progress("modal:queuing", 5)
    started_at = time.time()

    # Look up the user-deployed Function. If it's not deployed, fail with a
    # crystal-clear instruction so the caller can `modal deploy` once and retry.
    try:
        fn = modal.Function.lookup(APP_NAME, FUNCTION_NAME)
    except Exception as err:  # noqa: BLE001
        raise RuntimeError(
            f"modal: function `{FUNCTION_NAME}` not deployed under app `{APP_NAME}`. "
            f"Deploy with `modal deploy apps/trainer/modal_app.py` (template ships in next wave)."
        ) from err

    # Translate the Job into a serialisable spec. Modal Functions accept any
    # pickleable arg; we stay JSON-safe so the spec is reproducible.
    spec = {
        "tenant": job.tenant,
        "namespace": job.namespace,
        "base_model": job.base_model,
        "target_size": job.target_size,
        "pair_count": job.pair_count,
        "corpus_url": job.corpus_url,
        "holdout_ratio": job.holdout_ratio,
    }

    on_progress("modal:submitting", 15)
    call = fn.spawn(spec)

    # Poll. Modal Functions emit logs we don't have easy access to inside
    # the runner: surface a coarse progress signal until result.
    while True:
        try:
            result = call.get(timeout=10)
            break
        except modal.exception.OutputExpiredError as err:
            raise RuntimeError(f"modal: output expired: {err}") from err
        except TimeoutError:
            on_progress("modal:running", 50)

    finished_at = time.time()
    on_progress("modal:downloading_adapter", 90)

    # Expected result envelope from the deployed function:
    #   {"metrics": {...}, "adapter_bytes": <base64>, "adapter_filename": "..."}
    if not isinstance(result, dict) or "metrics" not in result:
        raise RuntimeError(f"modal: unexpected result shape: {type(result).__name__}")

    import base64
    import hashlib

    adapter_bytes = base64.b64decode(result.get("adapter_bytes", ""))
    if not adapter_bytes:
        raise RuntimeError("modal: function returned no adapter bytes")
    filename = result.get("adapter_filename", f"{job.job_id}.adapter.zip")
    out_path = adapter_dir / filename
    out_path.write_bytes(adapter_bytes)
    sha = hashlib.sha256(adapter_bytes).hexdigest()

    on_progress("modal:complete", 100)

    return {
        "metrics": {**result["metrics"], "backend": "modal"},
        "adapter": {
            "url": f"file://{out_path.resolve()}",
            "sha256": "sha256-" + sha,
            "size_bytes": len(adapter_bytes),
            "format": result.get("adapter_format", "peft-lora"),
        },
        "compute": {
            "backend": "modal",
            "device": result.get("device", "modal-gpu"),
            "cost_usd": result.get("cost_usd"),
            "started_at": started_at,
            "finished_at": finished_at,
            "duration_seconds": round(finished_at - started_at, 3),
            "provenance": {
                "app": APP_NAME,
                "function": FUNCTION_NAME,
                "modal_call_id": getattr(call, "object_id", None),
            },
        },
    }
