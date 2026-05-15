"""
apps/capture/image.py

Vision input pre-processor for `kolm capture <image>`.

What kolm capture does today: text-only OpenAI/Anthropic proxy that records
chat traffic, tags it, and lays down example fixtures the trainer turns into
recipes. This module extends capture to images so users can train models on
multimodal traces (screenshots, X-rays, receipts, document scans).

Mental model:
  1. Caller hands us a file path, URL, or base64 string.
  2. We normalize to PIL.Image, resize-clamp to 1024px max, JPEG-encode at
     q=90, and SHA-256 hash the bytes for de-dup.
  3. Optionally extract OCR via tesseract (if installed) or pass through.
  4. Return a CaptureImage dict ready to drop into the example payload.

This module degrades gracefully: missing PIL means we fall back to raw-byte
pass-through with a hash; missing tesseract means OCR is skipped.

We deliberately don't ship our own model weights here. The vision model is
chosen at serve-time via the artifact manifest (Qwen2.5-VL-3B-Instruct is
the default; the model registry in src/models.js carries the mapping).
"""

from __future__ import annotations
import base64
import hashlib
import io
import os
import re
from pathlib import Path
from typing import Optional, Dict, Any, Union


# Max edge length for ingested images. Anything larger gets resized down.
MAX_EDGE_PX = int(os.environ.get("KOLM_CAPTURE_MAX_EDGE", "1024"))
JPEG_QUALITY = int(os.environ.get("KOLM_CAPTURE_JPEG_QUALITY", "90"))


def _load_pil():
    try:
        from PIL import Image
        return Image
    except ImportError:
        return None


def _read_bytes(src: Union[str, bytes]) -> bytes:
    """Resolve any of (path, http(s) URL, data: URI, base64 string, bytes) to raw bytes."""
    if isinstance(src, (bytes, bytearray, memoryview)):
        return bytes(src)
    s = str(src)
    # data:image/png;base64,XXXX
    if s.startswith("data:"):
        _, _, payload = s.partition(",")
        return base64.b64decode(payload)
    # bare base64 (heuristic: looks like b64 with no scheme)
    if re.fullmatch(r"[A-Za-z0-9+/=\s]+", s) and len(s) > 200 and not Path(s).exists():
        try:
            return base64.b64decode(s, validate=False)
        except Exception:
            pass
    # http/https — defer importing urllib unless needed
    if s.startswith("http://") or s.startswith("https://"):
        import urllib.request
        req = urllib.request.Request(s, headers={"User-Agent": "kolm-capture/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.read()
    # local file
    p = Path(s)
    if not p.exists():
        raise FileNotFoundError(f"image not found: {s}")
    return p.read_bytes()


def _normalize(raw: bytes) -> Dict[str, Any]:
    """Return {bytes, mime, width, height, normalized_bytes}."""
    Image = _load_pil()
    if Image is None:
        return {
            "bytes": raw,
            "mime": "application/octet-stream",
            "width": None,
            "height": None,
            "normalized_bytes": raw,
            "normalized": False,
        }
    try:
        img = Image.open(io.BytesIO(raw))
    except Exception as exc:
        raise ValueError(f"cannot decode image: {exc}")

    w, h = img.size
    mime = f"image/{(img.format or 'JPEG').lower()}"

    # Resize if either edge is bigger than the cap.
    longest = max(w, h)
    if longest > MAX_EDGE_PX:
        scale = MAX_EDGE_PX / float(longest)
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    norm = buf.getvalue()
    return {
        "bytes": raw,
        "mime": "image/jpeg",
        "width": img.width,
        "height": img.height,
        "normalized_bytes": norm,
        "normalized": True,
    }


def _maybe_ocr(image_bytes: bytes) -> Optional[str]:
    """Extract text via tesseract if installed. Returns None when unavailable."""
    try:
        import pytesseract
        from PIL import Image
    except ImportError:
        return None
    try:
        img = Image.open(io.BytesIO(image_bytes))
        text = pytesseract.image_to_string(img).strip()
        return text or None
    except Exception:
        return None


def capture_image(
    src: Union[str, bytes],
    *,
    ocr: bool = False,
    label: Optional[str] = None,
    note: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Public API. Returns a CaptureImage dict suitable for embedding in an
    example payload alongside text. Shape:

      {
        "kind": "image",
        "hash": "sha256-...",
        "mime": "image/jpeg",
        "width": 1024, "height": 768,
        "data_b64": "...",       # the normalized JPEG, base64
        "ocr_text": Optional[str],
        "label": Optional[str],
        "note": Optional[str],
      }
    """
    raw = _read_bytes(src)
    norm = _normalize(raw)
    sha = hashlib.sha256(norm["normalized_bytes"]).hexdigest()
    payload = {
        "kind": "image",
        "hash": f"sha256-{sha}",
        "mime": norm["mime"],
        "width": norm["width"],
        "height": norm["height"],
        "data_b64": base64.b64encode(norm["normalized_bytes"]).decode("ascii"),
        "ocr_text": _maybe_ocr(norm["normalized_bytes"]) if ocr else None,
        "label": label,
        "note": note,
    }
    return payload


def as_example(image_dict: Dict[str, Any], prompt: str, response: str) -> Dict[str, Any]:
    """Wrap a CaptureImage with a prompt/response pair, ready for the trainer."""
    return {
        "input": {"text": prompt, "image": image_dict},
        "output": {"text": response},
        "labels": [image_dict.get("label")] if image_dict.get("label") else [],
    }
