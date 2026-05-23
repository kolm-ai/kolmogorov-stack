"""
apps/runtime/streaming_load.py  (W723 — STREAMING COMPILATION)

Per-layer streaming loader for .kolm artifacts.

The classical load path opens the zip, reads ALL weight shards into memory,
materializes tensors, then starts processing. For a 17.9 GB R1-32B INT4
artifact this can cost 30+ wall-clock seconds before the first token can be
generated — most of it spent waiting on shards 1..N before shard 0 is even
touched by the engine.

Streaming flips that: we iterate shards in the order declared by the manifest
(or, when the manifest does not list them, by sorted shard index), and yield
ONE event per shard with the names of the layers carried by that shard. The
caller can hand each layer to the engine the moment it surfaces, overlapping
disk I/O on shards k+1..N with compute on shard k.

Design contract
---------------
- Pure-Python. No torch / no safetensors / no numpy import in this module.
- Reads ONLY shard metadata from the manifest. Actual tensor bytes are
  NEVER deserialized here — that is the engine's job downstream.
- Honest envelope on every error path. `not_a_kolm_artifact` is raised
  with an actionable hint when the file is not a valid .kolm zip OR is
  missing the manifest.
- Importable as ``from streaming_load import stream_artifact_layers``.
- CLI entry point: ``python apps/runtime/streaming_load.py ART.kolm``.

Manifest shape
--------------
A .kolm manifest may declare shards in one of two shapes::

    # shape A: explicit ordered list
    {
      "weights": {
        "shards": [
          {"path": "weights/model-00001-of-00050.safetensors",
           "layers": ["model.embed_tokens.weight", "model.layers.0.input_layernorm.weight"]},
          {"path": "weights/model-00002-of-00050.safetensors",
           "layers": ["model.layers.0.self_attn.q_proj.weight", ...]},
          ...
        ]
      }
    }

    # shape B: HF-style weight_map (path-per-tensor)
    {
      "weights": {
        "weight_map": {
          "model.embed_tokens.weight": "weights/model-00001-of-00050.safetensors",
          "model.layers.0.input_layernorm.weight": "weights/model-00001-of-00050.safetensors",
          ...
        }
      }
    }

When the manifest declares NEITHER shape we fall back to listing every zip
entry under ``weights/`` (or shard-suffix patterns) and sorting by name —
this is the path real frontier-model exports take when shipped raw.

Event shape
-----------
Each event yielded by :func:`stream_artifact_layers` is a plain ``dict``::

    {
      "event":         "shard_ready",
      "shard_index":   <int, zero-based>,
      "total_shards":  <int>,
      "path":          "weights/model-00001-of-00050.safetensors",
      "bytes":         <int, shard byte length from zip header>,
      "bytes_loaded":  <int, cumulative including this shard>,
      "total_bytes":   <int, sum of all shard sizes>,
      "layer_names":   ["model.embed_tokens.weight", ...]
    }
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import zipfile
from collections.abc import Iterator


# --------------------------------------------------------------------------
# Errors
# --------------------------------------------------------------------------


class StreamingLoadError(Exception):
    """Honest-envelope error raised by stream_artifact_layers.

    Always carries a stable ``code`` (machine-readable) and a ``hint``
    (human-readable, actionable). Both flow into the CLI JSON envelope.
    """

    def __init__(self, code: str, hint: str = "", **extra: object) -> None:
        self.code = code
        self.hint = hint
        self.extra = extra
        super().__init__(f"{code}: {hint}" if hint else code)


# --------------------------------------------------------------------------
# Manifest helpers
# --------------------------------------------------------------------------


_SHARD_RE = re.compile(r"\.safetensors$|\.bin$|\.gguf$", re.IGNORECASE)
_SHARD_NUM_RE = re.compile(r"(\d+)(?:-of-\d+)?\.(?:safetensors|bin|gguf)$", re.IGNORECASE)


def _safe_load_manifest(zf: zipfile.ZipFile) -> dict:
    """Read manifest.json from the zip; raise StreamingLoadError if absent."""
    try:
        raw = zf.read("manifest.json")
    except KeyError as exc:
        raise StreamingLoadError(
            "not_a_kolm_artifact",
            "manifest.json missing from zip root — not a .kolm artifact",
        ) from exc
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise StreamingLoadError(
            "not_a_kolm_artifact",
            "manifest.json is not valid UTF-8 JSON",
        ) from exc
    if not isinstance(manifest, dict):
        raise StreamingLoadError(
            "not_a_kolm_artifact",
            "manifest.json must be a JSON object",
        )
    return manifest


def _shard_sort_key(name: str) -> tuple:
    """Sort key for fallback shard ordering.

    Prefers numeric ordering when the filename matches ``...NNNNN-of-MMMMM``
    or ``...NNNNN.<ext>``; falls back to lexicographic on the basename so
    ``model-2.safetensors`` < ``model-10.safetensors`` is preserved (the
    common shipped layout zero-pads, but raw exports do not always).
    """
    base = os.path.basename(name)
    m = _SHARD_NUM_RE.search(base)
    if m:
        try:
            return (0, int(m.group(1)), base)
        except ValueError:
            pass
    return (1, 0, base)


def _shards_from_manifest(manifest: dict, zip_names: list[str]) -> list[dict]:
    """Resolve the ordered list of shards to stream.

    Returns a list of ``{"path": str, "layers": list[str]}`` dicts in
    streaming order. ``layers`` may be empty when the manifest does not
    declare per-shard layer names; this is intentional (engines that do
    not need pre-bind tensor names still get the shard arrival signal).
    """
    weights = manifest.get("weights")
    if isinstance(weights, dict):
        # Shape A: explicit shards list with order baked in.
        shards = weights.get("shards")
        if isinstance(shards, list) and shards:
            out: list[dict] = []
            for s in shards:
                if not isinstance(s, dict):
                    continue
                path = s.get("path")
                if not isinstance(path, str) or not path:
                    continue
                raw_layers = s.get("layers")
                layers = [str(x) for x in raw_layers] if isinstance(raw_layers, list) else []
                out.append({"path": path, "layers": layers})
            if out:
                return out

        # Shape B: weight_map (HF-style). Reverse to per-shard layer list,
        # preserving FIRST-seen insertion order of paths.
        weight_map = weights.get("weight_map")
        if isinstance(weight_map, dict) and weight_map:
            per_shard: dict[str, list[str]] = {}
            order: list[str] = []
            for layer_name, shard_path in weight_map.items():
                if not isinstance(shard_path, str) or not shard_path:
                    continue
                if shard_path not in per_shard:
                    per_shard[shard_path] = []
                    order.append(shard_path)
                per_shard[shard_path].append(str(layer_name))
            # Sort by shard path to stabilize order (HF weight_map dicts
            # are insertion-ordered in Python 3.7+ but we cannot trust
            # producers wrote them in shard order).
            order.sort(key=_shard_sort_key)
            return [{"path": p, "layers": per_shard[p]} for p in order]

    # Fallback: discover by zip namelist. Any entry under weights/ that
    # looks like a shard.
    candidate = [n for n in zip_names if n.startswith("weights/") and _SHARD_RE.search(n)]
    if not candidate:
        # Last-ditch: any safetensors/bin/gguf at zip root or one level deep.
        candidate = [n for n in zip_names if _SHARD_RE.search(n)]
    candidate.sort(key=_shard_sort_key)
    return [{"path": p, "layers": []} for p in candidate]


# --------------------------------------------------------------------------
# Streaming iterator
# --------------------------------------------------------------------------


def stream_artifact_layers(artifact_path: str | os.PathLike) -> Iterator[dict]:
    """Yield one event per shard, in declared (or sorted) order.

    Parameters
    ----------
    artifact_path :
        Path to a .kolm zip artifact.

    Yields
    ------
    dict
        See module docstring "Event shape".

    Raises
    ------
    StreamingLoadError
        - ``not_a_kolm_artifact`` if the path is not a readable zip or
          the manifest is missing/malformed.
        - ``no_shards_in_artifact`` if the manifest resolved to zero
          shards AND the zip contains no weight files. Pure-weights
          .kolm artifacts that ship no shards (e.g. tiny LoRA-only
          packs with adapter inside a single file) are still handled
          gracefully — the fallback discovery picks them up.
    """
    p = os.fspath(artifact_path)
    if not os.path.exists(p):
        raise StreamingLoadError(
            "not_a_kolm_artifact",
            f"file does not exist: {p}",
        )
    if not zipfile.is_zipfile(p):
        raise StreamingLoadError(
            "not_a_kolm_artifact",
            f"file is not a valid zip (.kolm artifacts are zips): {p}",
        )

    with zipfile.ZipFile(p) as zf:
        manifest = _safe_load_manifest(zf)
        zip_names = zf.namelist()
        shards = _shards_from_manifest(manifest, zip_names)

        # Resolve sizes from the zip's central directory — no decompression.
        info_by_name = {i.filename: i for i in zf.infolist()}

        sized: list[dict] = []
        for s in shards:
            info = info_by_name.get(s["path"])
            if info is None:
                # Manifest references a shard that isn't in the zip.
                # Skip silently rather than blow up — the engine will
                # surface a clearer error when it tries to read it.
                continue
            sized.append({
                "path": s["path"],
                "layers": s["layers"],
                "bytes": int(info.file_size),
            })

        if not sized:
            raise StreamingLoadError(
                "no_shards_in_artifact",
                "manifest declared no weight shards and zip contains no "
                "weights/*.safetensors entries",
            )

        total_bytes = sum(s["bytes"] for s in sized)
        total_shards = len(sized)
        bytes_loaded = 0

        for i, s in enumerate(sized):
            bytes_loaded += s["bytes"]
            yield {
                "event": "shard_ready",
                "shard_index": i,
                "total_shards": total_shards,
                "path": s["path"],
                "bytes": s["bytes"],
                "bytes_loaded": bytes_loaded,
                "total_bytes": total_bytes,
                "layer_names": list(s["layers"]),
            }


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="streaming_load",
        description=(
            "W723 streaming loader: yield one event per .kolm weight shard "
            "in arrival order so engines can begin processing layer 0 while "
            "shards 1..N are still loading."
        ),
    )
    p.add_argument("artifact", nargs="?", help="path to a .kolm zip artifact")
    p.add_argument(
        "--json",
        action="store_true",
        help="emit one JSON line per shard event to stdout",
    )
    p.add_argument(
        "--summary",
        action="store_true",
        help="emit ONE JSON summary at end (total shards, total bytes, layers)",
    )
    return p


def _main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.artifact is None:
        parser.print_help(sys.stderr)
        return 0

    events: list[dict] = []
    try:
        for ev in stream_artifact_layers(args.artifact):
            if args.json or args.summary:
                events.append(ev)
                if args.json and not args.summary:
                    sys.stdout.write(json.dumps(ev) + "\n")
                    sys.stdout.flush()
            else:
                # Human line. Stays on one line so callers can grep.
                sys.stdout.write(
                    f"shard {ev['shard_index'] + 1}/{ev['total_shards']} "
                    f"{ev['path']} ({ev['bytes']} bytes, "
                    f"{len(ev['layer_names'])} layers)\n"
                )
                sys.stdout.flush()
    except StreamingLoadError as e:
        sys.stderr.write(
            json.dumps({"ok": False, "error": e.code, "hint": e.hint}) + "\n"
        )
        return 2

    if args.summary:
        last = events[-1] if events else {}
        all_layers: list[str] = []
        for ev in events:
            all_layers.extend(ev.get("layer_names", []))
        sys.stdout.write(json.dumps({
            "ok": True,
            "total_shards": last.get("total_shards", 0),
            "total_bytes": last.get("total_bytes", 0),
            "layer_count": len(all_layers),
        }) + "\n")

    return 0


if __name__ == "__main__":
    sys.exit(_main())
