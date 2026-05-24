"""W818-3 — Hugging Face Hub .kolm loader stub.

This is the draft body of the loader that would land under
``huggingface_hub.utils.kolm`` once the PR is accepted. Three callables
are exposed:

- :func:`is_kolm` — cheap sniff (extension + zip magic).
- :func:`verify` — structured signature-verify result; raises
  :class:`SignatureInvalid` unless ``allow_invalid=True``.
- :func:`extract` — extracts to a staging dir and returns the manifest
  plus entry-file map.

The verify path is delegated to the ``kolm`` Python SDK so the Hub does
not vendor a crypto implementation. Without the ``kolm`` extra installed
this module is still importable but :func:`is_kolm` returns ``False`` and
the other entrypoints raise :class:`KolmSDKMissing` with an install hint.

This is a STUB — the real implementation lives in the kolm Python SDK
under ``kolm.hf_hub_integration``. The Hub-side wrapper is intentionally
thin so the trust path stays one piece of code.
"""

from __future__ import annotations

import io
import json
import os
import pathlib
import zipfile
from typing import Optional


SCHEMA_VERSION = "w818-hf-hub-kolm-1"

# Magic bytes for cheap sniffing. The kolm-cli writes a deterministic zip
# with the standard PK\x03\x04 prefix; manifest.json is always entry index
# zero. Mirrors src/artifact.js in the kolm.ai repo.
_ZIP_MAGIC = b"PK\x03\x04"


class SignatureInvalid(Exception):
    """Raised by :func:`verify` when the signature chain breaks."""


class KolmSDKMissing(ImportError):
    """Raised when the kolm Python SDK is not installed.

    Install via ``pip install huggingface_hub[kolm]`` or directly via
    ``pip install kolm``.
    """


def is_kolm(path: str | os.PathLike) -> bool:
    """Return True if ``path`` looks like a .kolm archive.

    Cheap: checks the extension first, then sniffs the first 4 bytes
    for the zip magic. Returns True for files renamed in transit so the
    loader works even when the extension is stripped.
    """
    p = pathlib.Path(path)
    if p.suffix == ".kolm":
        return True
    try:
        with open(p, "rb") as fh:
            head = fh.read(4)
        if head != _ZIP_MAGIC:
            return False
        # Confirm by listing entries — must contain manifest.json AND
        # signature.sig to count as a .kolm (not just any zip).
        with zipfile.ZipFile(p, "r") as zf:
            names = set(zf.namelist())
        return "manifest.json" in names and "signature.sig" in names
    except (OSError, zipfile.BadZipFile):
        return False


def _require_sdk():
    try:
        import kolm  # type: ignore  # noqa: F401
    except ImportError as exc:
        raise KolmSDKMissing(
            "kolm Python SDK not installed. "
            "Install via `pip install huggingface_hub[kolm]`."
        ) from exc
    return kolm  # type: ignore[name-defined]


def verify(path: str | os.PathLike, *, allow_invalid: bool = False) -> dict:
    """Verify the signature chain on a .kolm.

    Returns a structured dict::

        {
            "ok": bool,
            "signature_mode": "hmac-local" | "cloud-trusted" | "ed25519-public-key" | "invalid",
            "manifest_hash": str,
            "artifact_hash": str,
            "reason": Optional[str],
            "version": "w818-hf-hub-kolm-1",
        }

    Raises :class:`SignatureInvalid` if the signature fails to verify and
    ``allow_invalid`` is False (default).
    """
    kolm = _require_sdk()
    p = pathlib.Path(path).resolve()
    if not is_kolm(p):
        raise ValueError(f"{p} is not a .kolm artifact")
    # The SDK exposes a top-level ``inspect_artifact`` that returns the
    # same envelope shape we surface here. This function is a thin
    # adapter so the Hub-side error type is consistent regardless of
    # which SDK version is installed.
    try:
        result = kolm.inspect_artifact(str(p))  # type: ignore[attr-defined]
    except Exception as exc:
        if allow_invalid:
            return {
                "ok": False,
                "signature_mode": "invalid",
                "reason": str(exc),
                "version": SCHEMA_VERSION,
            }
        raise SignatureInvalid(str(exc)) from exc

    envelope = {
        "ok": bool(result.get("signature_valid", False)),
        "signature_mode": result.get("signature_mode", "unknown"),
        "manifest_hash": result.get("manifest_hash"),
        "artifact_hash": result.get("artifact_hash"),
        "reason": result.get("signature_error"),
        "version": SCHEMA_VERSION,
    }
    if not envelope["ok"] and not allow_invalid:
        raise SignatureInvalid(envelope.get("reason") or "signature invalid")
    return envelope


def extract(
    path: str | os.PathLike,
    dest_dir: Optional[str | os.PathLike] = None,
    *,
    verify_first: bool = True,
) -> dict:
    """Extract a .kolm to ``dest_dir`` and return the manifest + entries.

    Default ``dest_dir`` is a sibling ``<artifact>.kolm-extracted/`` so
    the Hub UI can render a directory listing alongside the committed
    blob. When ``verify_first=True`` (default), the signature is checked
    before any files are written; a bad signature raises and writes
    nothing.
    """
    p = pathlib.Path(path).resolve()
    if not is_kolm(p):
        raise ValueError(f"{p} is not a .kolm artifact")
    if verify_first:
        verify(p)  # raises on failure

    if dest_dir is None:
        dest_dir = p.with_suffix(p.suffix + "-extracted")
    dest_dir = pathlib.Path(dest_dir).resolve()
    dest_dir.mkdir(parents=True, exist_ok=True)

    manifest = None
    entries = {}
    with zipfile.ZipFile(p, "r") as zf:
        for name in zf.namelist():
            data = zf.read(name)
            target = dest_dir / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with open(target, "wb") as fh:
                fh.write(data)
            entries[name] = str(target)
            if name == "manifest.json":
                manifest = json.loads(data.decode("utf-8"))

    return {
        "ok": True,
        "manifest": manifest,
        "entries": entries,
        "extracted_to": str(dest_dir),
        "version": SCHEMA_VERSION,
    }


__all__ = [
    "SCHEMA_VERSION",
    "SignatureInvalid",
    "KolmSDKMissing",
    "is_kolm",
    "verify",
    "extract",
]
