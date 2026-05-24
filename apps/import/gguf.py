#!/usr/bin/env python3
"""W740 GGUF header parser.

Reads the GGUF magic + version + tensor_count + kv_count header (and a small
prefix of the metadata KV block) so kolm can wrap a GGUF model as a
`not_kolm_compiled` manifest without loading any tensor weights into memory.

GGUF v3 layout (see https://github.com/ggerganov/ggml/blob/master/docs/gguf.md):

    magic:           4 bytes ASCII "GGUF"
    version:         uint32 LE
    tensor_count:    uint64 LE
    metadata_kv:     uint64 LE
    (then `metadata_kv` repetitions of key+type+value, followed by tensor info,
     followed by the tensor blob. We do NOT walk past the kv header — only
     the COUNT, because that's enough for the not_kolm_compiled wrap.)

stdlib only. We never load tensors. Output is single-line JSON on stdout.
"""

from __future__ import annotations

import hashlib
import json
import os
import struct
import sys
from pathlib import Path

GGUF_MAGIC = b"GGUF"


def _sha256_streaming(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# Map GGUF file_type integer -> short human label. The full table is in
# ggml-quants.h; we cover the common quantizations a buyer is likely to see.
# Unknown integers pass through as f"unknown_{n}" — never crash.
_QUANT_LABELS = {
    0: "f32",
    1: "f16",
    2: "q4_0",
    3: "q4_1",
    6: "q5_0",
    7: "q5_1",
    8: "q8_0",
    9: "q8_1",
    10: "q2_k",
    11: "q3_k",
    12: "q4_k",
    13: "q5_k",
    14: "q6_k",
    15: "q8_k",
    18: "iq2_xxs",
    19: "iq2_xs",
    20: "iq3_xxs",
    21: "iq1_s",
    22: "iq4_nl",
    23: "iq3_s",
    24: "iq2_s",
    25: "iq4_xs",
    26: "i8",
    27: "i16",
    28: "i32",
    29: "i64",
    30: "f64",
    31: "iq1_m",
    32: "bf16",
}


def parse(path: str) -> dict:
    """Return the W740 envelope dict for a GGUF file at `path`."""
    p = Path(path)
    if not p.is_file():
        return {
            "ok": False,
            "error": "gguf_parse_failed",
            "hint": f"file not found: {path}",
        }
    try:
        size = p.stat().st_size
        if size < 24:
            return {
                "ok": False,
                "error": "gguf_parse_failed",
                "hint": "file is smaller than GGUF header (magic+version+tensor_count+kv_count = 24 bytes)",
            }
        with open(path, "rb") as fh:
            magic = fh.read(4)
            if magic != GGUF_MAGIC:
                return {
                    "ok": False,
                    "error": "gguf_parse_failed",
                    "hint": f"expected magic b'GGUF'; got {magic!r}",
                }
            (version,) = struct.unpack("<I", fh.read(4))
            (tensor_count,) = struct.unpack("<Q", fh.read(8))
            (kv_count,) = struct.unpack("<Q", fh.read(8))
        # Walk the metadata KV block to surface the keys (NOT the values).
        # We cap the walk so a malicious or corrupted file can't make us OOM:
        # if any single string length exceeds 1 MiB or kv_count > 65k we
        # bail with a partial-success envelope. The wrap is still honest —
        # we just emit raw_metadata_keys we managed to recover.
        raw_keys: list[str] = []
        quant: str | None = None
        params_b: float | None = None
        if kv_count <= 65536:
            try:
                with open(path, "rb") as fh:
                    fh.seek(24)
                    for _ in range(int(kv_count)):
                        (key_len,) = struct.unpack("<Q", fh.read(8))
                        if key_len > (1 << 20):
                            break
                        key = fh.read(int(key_len)).decode("utf-8", "replace")
                        raw_keys.append(key)
                        (vtype,) = struct.unpack("<I", fh.read(4))
                        # Value parsing for primitive types we care about:
                        #   0 u8, 1 i8, 2 u16, 3 i16, 4 u32, 5 i32, 6 f32,
                        #   7 bool, 8 string, 9 array, 10 u64, 11 i64, 12 f64
                        if vtype == 0:  # u8
                            v = struct.unpack("<B", fh.read(1))[0]
                        elif vtype == 1:  # i8
                            v = struct.unpack("<b", fh.read(1))[0]
                        elif vtype == 2:  # u16
                            v = struct.unpack("<H", fh.read(2))[0]
                        elif vtype == 3:  # i16
                            v = struct.unpack("<h", fh.read(2))[0]
                        elif vtype == 4:  # u32
                            v = struct.unpack("<I", fh.read(4))[0]
                        elif vtype == 5:  # i32
                            v = struct.unpack("<i", fh.read(4))[0]
                        elif vtype == 6:  # f32
                            v = struct.unpack("<f", fh.read(4))[0]
                        elif vtype == 7:  # bool
                            v = bool(struct.unpack("<B", fh.read(1))[0])
                        elif vtype == 8:  # string
                            (slen,) = struct.unpack("<Q", fh.read(8))
                            if slen > (1 << 20):
                                break
                            v = fh.read(int(slen)).decode("utf-8", "replace")
                        elif vtype == 10:  # u64
                            v = struct.unpack("<Q", fh.read(8))[0]
                        elif vtype == 11:  # i64
                            v = struct.unpack("<q", fh.read(8))[0]
                        elif vtype == 12:  # f64
                            v = struct.unpack("<d", fh.read(8))[0]
                        elif vtype == 9:  # array — skip; the elem-type header is rare
                            # We don't deep-walk arrays. The format spec puts an
                            # 8-byte elem-type then 8-byte count then payload;
                            # for a partial parse we just bail to avoid walking
                            # an unbounded vocab list.
                            break
                        else:
                            # Unknown type — bail rather than misread.
                            break
                        if key == "general.file_type" and isinstance(v, int):
                            quant = _QUANT_LABELS.get(v, f"unknown_{v}")
                        elif key == "general.parameter_count" and isinstance(v, (int, float)):
                            params_b = round(float(v) / 1e9, 3)
            except Exception:
                # Best-effort metadata walk; don't fail the whole parse.
                pass
        return {
            "ok": True,
            "format": "gguf",
            "version": int(version),
            "tensor_count": int(tensor_count),
            "kv_count": int(kv_count),
            "params_b": params_b,
            "quant": quant,
            "source_path": str(p.resolve()),
            "sha256": _sha256_streaming(path),
            "size_bytes": int(size),
            "raw_metadata_keys": raw_keys,
        }
    except Exception as e:
        return {
            "ok": False,
            "error": "gguf_parse_failed",
            "hint": f"{type(e).__name__}: {e}",
        }


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(json.dumps({
            "ok": False,
            "error": "gguf_parse_failed",
            "hint": "usage: python3 apps/import/gguf.py <file.gguf>",
        }))
        return 3
    result = parse(argv[1])
    print(json.dumps(result))
    return 0 if result.get("ok") else 3


if __name__ == "__main__":
    sys.exit(main(sys.argv))
