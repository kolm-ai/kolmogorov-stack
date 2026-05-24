#!/usr/bin/env python3
"""
apps/trainer/vlm_distill.py
W771 -- Vision-language distillation entry point.

A CLI wrapper that turns a JSONL of captured vision turns into a distilled
VLM student. This is the *distillation* pipeline; apps/trainer/vlm.py is the
SFT/LoRA tuning pipeline. The split mirrors apps/trainer/distill_cot.py vs
apps/trainer/distill.py: distill_* invokes a teacher to relabel data, then
trains the student on the teacher labels; the SFT modules just train on the
provided labels directly.

Stdlib only at import time. torch / transformers / PIL are imported lazily
inside `_invoke_trainer()` so a `--dry-run` invocation NEVER pulls heavy
dependencies. The honest contract:

  --dry-run  : validate input shape, count vision rows, emit a run-meta
               scaffold with `trainer_not_invoked:true`. NEVER imports
               torch. NEVER fabricates training results.

  live mode  : import torch + transformers + PIL. ImportError -> exit 3
               with honest envelope {ok:false, error:'torch_not_available'}.
               NEVER silently degrades to dry-run.

Exit codes (sysexits-style):

  0  ok
  2  bad input (missing --captures file, malformed JSONL, etc.)
  3  torch_not_available (live mode only; dry-run never hits this)
  4  no_vision_captures (file parsed but zero rows have image_url blocks)
  5  model_load_failed (live mode only; teacher model id rejected)

The output --out path receives a run-meta.json envelope. Fields:

  ok:                          true|false
  mode:                        'dry_run' | 'live'
  version:                     'w771-v1'
  vision_captures_total:       int
  vision_captures_with_image_url:    int
  vision_captures_with_base64:       int
  trainer_not_invoked:         bool (true in dry-run, false in live success)
  hint:                        string (next-action guidance)
  model:                       string (teacher model id)
  max_samples:                 int

Distinct from apps/trainer/vlm.py (LoRA SFT trainer) and
apps/trainer/distill_cot.py (chain-of-thought distillation for text models).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

VERSION = "w771-v1"

# Exit codes line up with cli/kolm.js EXIT constants so the spawning
# process sees a stable signal.
EXIT_OK = 0
EXIT_BAD_INPUT = 2
EXIT_TORCH_NOT_AVAILABLE = 3
EXIT_NO_VISION = 4
EXIT_MODEL_LOAD_FAILED = 5


def _print_envelope(envelope, out_path=None):
    """Write the envelope to --out if set, also echo to stdout for caller."""
    line = json.dumps(envelope, indent=2, sort_keys=True)
    print(line)
    if out_path:
        try:
            Path(out_path).parent.mkdir(parents=True, exist_ok=True)
            Path(out_path).write_text(line + "\n", encoding="utf-8")
        except OSError as exc:
            sys.stderr.write(
                "# vlm_distill: failed to write --out path "
                + repr(out_path) + ": " + str(exc) + "\n"
            )


def _detect_vision_blocks(message):
    """
    Lightweight mirror of src/vision-capture.js detectVisionCapture.
    Returns dict with counts of url/base64 blocks per message.

    Recognizes:
      OpenAI            content[].type == 'image_url'
      Anthropic         content[].type == 'image' (source.type in {base64, url})
      Google            content[].fileData / content[].inlineData
    """
    out = {"has_vision": False, "url_count": 0, "base64_count": 0}
    if not isinstance(message, dict):
        return out
    content = message.get("content")
    if content is None:
        return out
    if isinstance(content, str):
        return out
    if not isinstance(content, list):
        return out
    for block in content:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "image_url":
            url_field = block.get("image_url")
            # Both shapes: {image_url: {url: "..."}} and {image_url: "..."}.
            if isinstance(url_field, dict):
                url = url_field.get("url")
            elif isinstance(url_field, str):
                url = url_field
            else:
                url = None
            if isinstance(url, str) and url.startswith("data:"):
                out["base64_count"] += 1
            else:
                out["url_count"] += 1
            out["has_vision"] = True
            continue
        if btype == "image":
            src = block.get("source")
            if isinstance(src, dict):
                stype = src.get("type")
                if stype == "base64":
                    out["base64_count"] += 1
                else:
                    out["url_count"] += 1
            else:
                out["url_count"] += 1
            out["has_vision"] = True
            continue
        # Google fileData / inlineData
        if isinstance(block.get("fileData"), dict):
            out["url_count"] += 1
            out["has_vision"] = True
            continue
        if isinstance(block.get("inlineData"), dict):
            out["base64_count"] += 1
            out["has_vision"] = True
            continue
    return out


def _scan_captures(captures_path):
    """
    Walk the JSONL one row at a time. Yields (row_dict, vision_summary) pairs.

    Tolerates blank lines and JSON parse errors per-row: parse errors are
    surfaced as warnings on stderr but do not abort the whole scan. The
    honest count of malformed rows lands in the run-meta as 'malformed_rows'.
    """
    malformed = 0
    rows_total = 0
    rows_with_vision = 0
    url_total = 0
    base64_total = 0
    if not os.path.isfile(captures_path):
        return None
    with open(captures_path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                malformed += 1
                continue
            rows_total += 1
            messages = row.get("messages") if isinstance(row, dict) else None
            if not isinstance(messages, list):
                continue
            row_has_vision = False
            for msg in messages:
                summary = _detect_vision_blocks(msg)
                if summary["has_vision"]:
                    row_has_vision = True
                    url_total += summary["url_count"]
                    base64_total += summary["base64_count"]
            if row_has_vision:
                rows_with_vision += 1
    return {
        "rows_total": rows_total,
        "rows_with_vision": rows_with_vision,
        "url_total": url_total,
        "base64_total": base64_total,
        "malformed_rows": malformed,
    }


def _invoke_trainer(args, scan):
    """
    Live-mode trainer. Imports torch + transformers + PIL LAZILY so dry-run
    never pays the import cost. Returns the run-meta envelope; the CLI
    layer is responsible for printing + writing.

    HONESTY: NEVER fabricates training results. If torch isn't installed we
    exit 3 with an honest envelope. If the model id is rejected we exit 5
    with the underlying error message preserved.
    """
    try:
        import torch  # noqa: F401  (live mode imports for side effect)
        import transformers  # noqa: F401
        import PIL  # noqa: F401
    except ImportError as exc:
        envelope = {
            "ok": False,
            "mode": "live",
            "error": "torch_not_available",
            "detail": str(exc),
            "hint": (
                "pip install torch transformers pillow to invoke the trainer. "
                "For dry-run validation re-run with --dry-run (stdlib-only)."
            ),
            "version": VERSION,
            "trainer_not_invoked": True,
        }
        _print_envelope(envelope, args.out)
        sys.exit(EXIT_TORCH_NOT_AVAILABLE)
    # Live trainer body deliberately stubbed. Bringing in the full vlm.py
    # trainer requires a deployed model card + dataset processor + GPU
    # acceleration that this CLI does not provision. We honestly surface
    # the wiring gap rather than silently no-op.
    envelope = {
        "ok": False,
        "mode": "live",
        "error": "live_trainer_not_wired",
        "detail": (
            "live VLM distill requires a deployed teacher endpoint + "
            "GPU. Wire apps/trainer/vlm.py vlm_trainer(...) and a teacher "
            "adapter (claude-3-5-sonnet-vision / gpt-4o-vision / Qwen2-VL) "
            "to populate the student dataset. This CLI surface validates "
            "input + emits run-meta scaffolds; the heavy trainer attaches "
            "via the same entry point."
        ),
        "hint": (
            "for now: --dry-run validates JSONL shape + emits a scaffold. "
            "Hook the trainer at _invoke_trainer() in this file."
        ),
        "version": VERSION,
        "vision_captures_total": scan["rows_total"],
        "vision_captures_with_image_url": scan["url_total"],
        "vision_captures_with_base64": scan["base64_total"],
        "model": args.model,
        "max_samples": args.max_samples,
        "trainer_not_invoked": True,
    }
    _print_envelope(envelope, args.out)
    sys.exit(EXIT_MODEL_LOAD_FAILED)


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="vlm_distill",
        description="W771 - vision-language distillation entry point",
    )
    parser.add_argument("--captures", required=True,
                        help="path to JSONL of captured vision turns")
    parser.add_argument("--out", default=None,
                        help="path to write run-meta.json (also echoed to stdout)")
    parser.add_argument("--dry-run", action="store_true",
                        help="validate input + emit scaffold WITHOUT importing torch")
    parser.add_argument("--model", default="claude-3-5-sonnet-vision",
                        help="teacher VLM model id (e.g. claude-3-5-sonnet-vision, gpt-4o-vision)")
    parser.add_argument("--max-samples", type=int, default=0,
                        help="cap on the number of training samples (0 = no cap)")

    args = parser.parse_args(argv)

    scan = _scan_captures(args.captures)
    if scan is None:
        envelope = {
            "ok": False,
            "error": "captures_file_not_found",
            "detail": "no file at " + repr(args.captures),
            "hint": "pass --captures <path>; the file must be JSONL (one row per line).",
            "version": VERSION,
        }
        _print_envelope(envelope, args.out)
        sys.exit(EXIT_BAD_INPUT)

    if scan["rows_total"] == 0 and scan["malformed_rows"] == 0:
        envelope = {
            "ok": False,
            "error": "captures_file_empty",
            "detail": "0 JSONL rows in " + repr(args.captures),
            "hint": "capture vision turns via /v1/capture/log with image_url content blocks first.",
            "version": VERSION,
        }
        _print_envelope(envelope, args.out)
        sys.exit(EXIT_BAD_INPUT)

    if scan["rows_with_vision"] == 0:
        envelope = {
            "ok": False,
            "error": "no_vision_captures",
            "detail": (
                "scanned " + str(scan["rows_total"]) + " rows; none carried image_url, "
                "image, or fileData/inlineData content blocks."
            ),
            "hint": (
                "vision distill requires JSONL rows with messages[].content[] "
                "blocks of type 'image_url' (OpenAI), 'image' (Anthropic), or "
                "fileData/inlineData (Google). Re-check capture wiring."
            ),
            "version": VERSION,
            "rows_total": scan["rows_total"],
            "rows_with_vision": scan["rows_with_vision"],
            "malformed_rows": scan["malformed_rows"],
        }
        _print_envelope(envelope, args.out)
        sys.exit(EXIT_NO_VISION)

    if args.dry_run:
        envelope = {
            "ok": True,
            "mode": "dry_run",
            "version": VERSION,
            "vision_captures_total": scan["rows_with_vision"],
            "vision_captures_with_image_url": scan["url_total"],
            "vision_captures_with_base64": scan["base64_total"],
            "rows_scanned": scan["rows_total"],
            "malformed_rows": scan["malformed_rows"],
            "model": args.model,
            "max_samples": args.max_samples,
            "trainer_not_invoked": True,
            "hint": (
                "pip install torch transformers pillow to invoke trainer. "
                "Re-run without --dry-run to attempt live distill."
            ),
        }
        _print_envelope(envelope, args.out)
        sys.exit(EXIT_OK)

    # Live mode falls through to _invoke_trainer which exits.
    _invoke_trainer(args, scan)


if __name__ == "__main__":
    main()
