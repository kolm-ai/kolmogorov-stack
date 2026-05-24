#!/usr/bin/env python3
"""W740 safetensors header parser.

Reads the safetensors header so kolm can wrap a safetensors model as a
`not_kolm_compiled` manifest without loading any tensor weights into memory.

safetensors layout (https://github.com/huggingface/safetensors/blob/main/docs/source/index.mdx):

    header_size:    uint64 little-endian (8 bytes)
    header_json:    UTF-8 JSON, header_size bytes
                    schema: { "<tensor_name>": { dtype, shape, data_offsets },
                              "__metadata__": { ... } }
    binary blob:    contiguous tensor bytes (NOT read)

stdlib ONLY — json + struct. We never load tensors. Output is single-line
JSON on stdout. On any structural failure we emit:

    { ok: false, error: "safetensors_parse_failed", hint: "..." }   (exit 3)
"""

from __future__ import annotations

import hashlib
import json
import struct
import sys
from pathlib import Path


# safetensors -> param-count multiplier. Most modern checkpoints store either
# fp16/bf16 (2 bytes/param) or fp32 (4 bytes/param); we infer params from the
# tensor shapes directly so this doesn't matter — but we keep the map for
# completeness and emit `quant` based on the most common dtype found.
_DTYPE_BYTES = {
    "BOOL":  1,  "U8":    1,  "I8":    1,
    "F8_E4M3": 1, "F8_E5M2": 1,
    "I16":   2,  "U16":   2,  "F16":   2,  "BF16":  2,
    "I32":   4,  "U32":   4,  "F32":   4,
    "I64":   8,  "U64":   8,  "F64":   8,
}


def _sha256_streaming(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _shape_prod(shape: list[int]) -> int:
    n = 1
    for d in shape:
        if not isinstance(d, int) or d < 0:
            return 0
        n *= d
    return n


def parse(path: str) -> dict:
    p = Path(path)
    if not p.is_file():
        return {
            "ok": False,
            "error": "safetensors_parse_failed",
            "hint": f"file not found: {path}",
        }
    try:
        size = p.stat().st_size
        if size < 8:
            return {
                "ok": False,
                "error": "safetensors_parse_failed",
                "hint": "file is smaller than the 8-byte u64 header-length prefix",
            }
        with open(path, "rb") as fh:
            (header_size,) = struct.unpack("<Q", fh.read(8))
            if header_size == 0 or header_size > (1 << 30):
                return {
                    "ok": False,
                    "error": "safetensors_parse_failed",
                    "hint": (
                        f"header_size {header_size} is implausible "
                        "(expected 1..2^30 bytes of JSON)"
                    ),
                }
            if 8 + header_size > size:
                return {
                    "ok": False,
                    "error": "safetensors_parse_failed",
                    "hint": (
                        f"declared header_size {header_size} extends past EOF "
                        f"(file is {size} bytes)"
                    ),
                }
            header_bytes = fh.read(int(header_size))
        try:
            header = json.loads(header_bytes.decode("utf-8"))
        except Exception as e:
            return {
                "ok": False,
                "error": "safetensors_parse_failed",
                "hint": f"header JSON decode failed: {type(e).__name__}: {e}",
            }
        if not isinstance(header, dict):
            return {
                "ok": False,
                "error": "safetensors_parse_failed",
                "hint": "header root must be a JSON object",
            }
        raw_keys = sorted(k for k in header.keys() if k != "__metadata__")
        metadata = header.get("__metadata__") if isinstance(header.get("__metadata__"), dict) else {}
        # Compute parameter count by summing shape products across tensors
        # (skipping __metadata__). dtype is sniffed via mode-count.
        total_params = 0
        dtype_counts: dict[str, int] = {}
        for tname, tinfo in header.items():
            if tname == "__metadata__":
                continue
            if not isinstance(tinfo, dict):
                continue
            shape = tinfo.get("shape")
            dtype = tinfo.get("dtype")
            if isinstance(shape, list):
                total_params += _shape_prod(shape)
            if isinstance(dtype, str):
                dtype_counts[dtype] = dtype_counts.get(dtype, 0) + 1
        dominant_dtype = None
        if dtype_counts:
            dominant_dtype = sorted(dtype_counts.items(), key=lambda kv: -kv[1])[0][0]
        params_b = round(total_params / 1e9, 3) if total_params else None
        quant = dominant_dtype.lower() if dominant_dtype else None
        return {
            "ok": True,
            "format": "safetensors",
            "header_size": int(header_size),
            "tensor_count": len(raw_keys),
            "params_b": params_b,
            "quant": quant,
            "source_path": str(p.resolve()),
            "sha256": _sha256_streaming(path),
            "size_bytes": int(size),
            "raw_metadata_keys": raw_keys,
            "user_metadata": metadata,
        }
    except Exception as e:
        return {
            "ok": False,
            "error": "safetensors_parse_failed",
            "hint": f"{type(e).__name__}: {e}",
        }


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(json.dumps({
            "ok": False,
            "error": "safetensors_parse_failed",
            "hint": "usage: python3 apps/import/safetensors.py <file.safetensors>",
        }))
        return 3
    result = parse(argv[1])
    print(json.dumps(result))
    return 0 if result.get("ok") else 3


if __name__ == "__main__":
    sys.exit(main(sys.argv))
