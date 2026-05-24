#!/usr/bin/env python3
"""W740 ONNX header sniffer.

ONNX models are full protobuf — there is no fixed magic header, the entire
file is a serialized `onnx.ModelProto`. Parsing it correctly requires a
protobuf descriptor (the `onnx` pip package) which we deliberately do NOT
add to kolm's dependency surface.

Strategy
--------
Read the first KiB and sniff for the protobuf field-tag bytes that a
well-formed ModelProto puts up-front:

    field 1 (ir_version):       wire type 0 (varint), tag byte 0x08
    field 2 (opset_import):     wire type 2 (length-delim), tag byte 0x12
    field 3 (producer_name):    wire type 2, tag byte 0x1a
    field 4 (producer_version): wire type 2, tag byte 0x22
    field 6 (model_version):    wire type 0, tag byte 0x30
    field 7 (graph):            wire type 2, tag byte 0x3a

Field 1 is essentially always emitted (ir_version is the only required
field), and field 7 (graph) holds the network proper. We attempt a partial
varint+length-delim walk just enough to recover ir_version + producer_name +
producer_version. We never claim more than this — anything else is flagged
as `onnx_metadata_partial`.

Output on success (always partial because we don't pull a protobuf dep):

    { ok: true, format: "onnx", ir_version, producer_name, producer_version,
      partial: true, hint: "...",
      sha256, size_bytes, source_path, raw_metadata_keys }

Output on signature mismatch:

    { ok: false, error: "onnx_parse_failed", hint: "..." }   (exit 3)

stdlib ONLY — no protobuf, no onnx-runtime.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path


def _sha256_streaming(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    """Decode a protobuf varint from `buf` at `pos`. Returns (value, new_pos).

    Raises ValueError if the varint runs past 10 bytes (corrupt) or past the
    buffer end. This is a deliberately tiny implementation; we never have to
    decode 64-bit signed/zigzag here.
    """
    result = 0
    shift = 0
    for i in range(10):
        if pos >= len(buf):
            raise ValueError("varint ran past buffer end")
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if (byte & 0x80) == 0:
            return result, pos
        shift += 7
    raise ValueError("varint exceeded 10 bytes")


def _read_length_delim(buf: bytes, pos: int) -> tuple[bytes, int]:
    length, pos = _read_varint(buf, pos)
    end = pos + length
    if end > len(buf):
        raise ValueError("length-delim field extends past buffer end")
    return buf[pos:end], end


def _parse_partial_header(head: bytes) -> dict:
    """Best-effort ModelProto field walk over a small head buffer."""
    fields: dict[str, object] = {}
    keys: list[str] = []
    pos = 0
    while pos < len(head):
        try:
            tag, pos = _read_varint(head, pos)
        except ValueError:
            break
        field_no = tag >> 3
        wire_type = tag & 0x07
        try:
            if wire_type == 0:  # varint
                val, pos = _read_varint(head, pos)
                if field_no == 1:
                    fields["ir_version"] = int(val)
                    keys.append("ir_version")
                elif field_no == 6:
                    fields["model_version"] = int(val)
                    keys.append("model_version")
            elif wire_type == 2:  # length-delimited
                payload, pos = _read_length_delim(head, pos)
                if field_no == 3:
                    fields["producer_name"] = payload.decode("utf-8", "replace")
                    keys.append("producer_name")
                elif field_no == 4:
                    fields["producer_version"] = payload.decode("utf-8", "replace")
                    keys.append("producer_version")
                elif field_no == 8:
                    fields["domain"] = payload.decode("utf-8", "replace")
                    keys.append("domain")
                elif field_no == 7:
                    # graph — too deep to walk without protobuf; just mark present
                    fields["has_graph"] = True
                    keys.append("graph")
                # otherwise skip silently
            elif wire_type == 1:  # 64-bit fixed
                pos += 8
            elif wire_type == 5:  # 32-bit fixed
                pos += 4
            else:
                # group / unknown — bail
                break
        except (ValueError, IndexError):
            break
    fields["raw_metadata_keys"] = keys
    return fields


def parse(path: str) -> dict:
    p = Path(path)
    if not p.is_file():
        return {
            "ok": False,
            "error": "onnx_parse_failed",
            "hint": f"file not found: {path}",
        }
    try:
        size = p.stat().st_size
        if size < 4:
            return {
                "ok": False,
                "error": "onnx_parse_failed",
                "hint": "file is smaller than minimal ModelProto",
            }
        with open(path, "rb") as fh:
            head = fh.read(min(1024, size))
        # Signature heuristic: a real ModelProto starts with field 1 (ir_version)
        # which is tag byte 0x08. We accept either that OR field 7 (graph,
        # tag byte 0x3a) which some exporters emit first.
        if not head:
            return {
                "ok": False,
                "error": "onnx_parse_failed",
                "hint": "could not read any bytes from file",
            }
        first = head[0]
        if first not in (0x08, 0x3a, 0x12):
            return {
                "ok": False,
                "error": "onnx_parse_failed",
                "hint": (
                    f"first byte 0x{first:02x} is not a valid ModelProto tag "
                    "(expected 0x08 ir_version, 0x12 opset_import, or 0x3a graph). "
                    "If this really is ONNX, install the `onnx` pip package and "
                    "use `python3 -m onnx ...` for full inspection."
                ),
            }
        partial = _parse_partial_header(head)
        keys = partial.pop("raw_metadata_keys", [])
        # Honest: we never claim to have parsed the full ModelProto. Surface
        # `partial: true` and `error: "onnx_metadata_partial"` if we didn't
        # recover ir_version (the only field required by the ONNX spec).
        if "ir_version" not in partial:
            return {
                "ok": True,
                "format": "onnx",
                "partial": True,
                "error": "onnx_metadata_partial",
                "hint": (
                    "stdlib-only sniffer recovered no ir_version. The file "
                    "looks like protobuf but a full ModelProto walk needs "
                    "the `onnx` pip package. We still emit sha256+size so "
                    "kolm import wrap can produce a not_kolm_compiled "
                    "manifest with honest provenance."
                ),
                "ir_version": None,
                "producer_name": None,
                "producer_version": None,
                "params_b": None,
                "quant": None,
                "source_path": str(p.resolve()),
                "sha256": _sha256_streaming(path),
                "size_bytes": int(size),
                "raw_metadata_keys": keys,
            }
        return {
            "ok": True,
            "format": "onnx",
            "partial": True,
            "hint": (
                "stdlib-only header walk; tensor count + parameter count "
                "are unavailable without the `onnx` pip package."
            ),
            "ir_version": partial.get("ir_version"),
            "model_version": partial.get("model_version"),
            "producer_name": partial.get("producer_name"),
            "producer_version": partial.get("producer_version"),
            "domain": partial.get("domain"),
            "has_graph": bool(partial.get("has_graph", False)),
            "params_b": None,
            "quant": None,
            "source_path": str(p.resolve()),
            "sha256": _sha256_streaming(path),
            "size_bytes": int(size),
            "raw_metadata_keys": keys,
        }
    except Exception as e:
        return {
            "ok": False,
            "error": "onnx_parse_failed",
            "hint": f"{type(e).__name__}: {e}",
        }


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(json.dumps({
            "ok": False,
            "error": "onnx_parse_failed",
            "hint": "usage: python3 apps/import/onnx.py <file.onnx>",
        }))
        return 3
    result = parse(argv[1])
    print(json.dumps(result))
    # `partial` with ir_version recovered is still ok:true. Only return 3 when
    # ok:false (signature mismatch / unreadable).
    return 0 if result.get("ok") else 3


if __name__ == "__main__":
    sys.exit(main(sys.argv))
