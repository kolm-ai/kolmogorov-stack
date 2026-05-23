#!/usr/bin/env python3
"""
W721 — TSAC kernel-selector stub.

This script is the Python end of workers/tsac/tsac.mjs. It reads a
validated TSAC profile (per-(layer,head) entries) and writes a kernel-name
selection table per entry to --output.

The script intentionally has NO heavy deps — argparse + json only. Real
CUDA / Metal / CPU sparse-attention kernel dispatch is a future wave; this
stub is the contract that a real kernel lookup table will plug into.

CLI:
  tsac.py --profile <path> --output <path> [--task <name>]

Exit codes:
  0   wrote selection table OK
  64  malformed profile (sysexits EX_USAGE)
  65  data error — entry missing required fields
  73  output path could not be written

Output schema (JSON):
  {
    "tsac_version": "w721-v1",
    "task": "<task>",
    "num_layers": <int>,
    "num_heads": <int>,
    "entries": [
      {
        "layer": <int>,
        "head": <int>,
        "kernel": "<prefill>_<decode>",
        "prefill_pattern": "<pattern>",
        "decode_policy": "<policy>",
      },
      ...
    ],
    "summary": {
      "total": <int>,
      "by_kernel": { "<kernel>": <count>, ... },
    }
  }
"""

import argparse
import json
import os
import sys


def main():
    parser = argparse.ArgumentParser(prog="kolm-tsac", description="TSAC kernel-selector stub")
    parser.add_argument("--profile", required=True, help="path to validated TSAC profile JSON")
    parser.add_argument("--output", required=False, help="write selection table to this file")
    parser.add_argument("--task", required=False, help="expected task name; rejects mismatched profiles")
    args = parser.parse_args()

    try:
        with open(args.profile, "r", encoding="utf-8") as fh:
            profile = json.load(fh)
    except FileNotFoundError:
        sys.stderr.write(json.dumps({
            "ok": False,
            "error": "profile_not_found",
            "profile": args.profile,
        }) + "\n")
        sys.exit(64)
    except json.JSONDecodeError as exc:
        sys.stderr.write(json.dumps({
            "ok": False,
            "error": "profile_parse_failed",
            "detail": str(exc),
        }) + "\n")
        sys.exit(64)

    # Accept either a wrapped {task, entries:[...]} object OR a bare entries
    # array. Mirrors src/tsac-profile.js validateProfile's dual-shape support.
    if isinstance(profile, list):
        entries = profile
        wrapper = {"entries": entries}
    elif isinstance(profile, dict) and "entries" in profile and isinstance(profile["entries"], list):
        wrapper = profile
        entries = profile["entries"]
    else:
        sys.stderr.write(json.dumps({
            "ok": False,
            "error": "profile_unrecognized_shape",
            "hint": "expected an array of entries OR an object with entries[]",
        }) + "\n")
        sys.exit(64)

    if not entries:
        sys.stderr.write(json.dumps({
            "ok": False,
            "error": "profile_no_entries",
        }) + "\n")
        sys.exit(64)

    task_name = wrapper.get("task")
    if args.task and task_name and args.task != task_name:
        sys.stderr.write(json.dumps({
            "ok": False,
            "error": "task_mismatch",
            "expected_task": args.task,
            "profile_task": task_name,
        }) + "\n")
        sys.exit(64)

    REQUIRED = ("layer", "head", "prefill_pattern", "decode_policy")
    out_entries = []
    by_kernel = {}
    for idx, e in enumerate(entries):
        if not isinstance(e, dict):
            sys.stderr.write(json.dumps({
                "ok": False,
                "error": "entry_not_object",
                "index": idx,
            }) + "\n")
            sys.exit(65)
        for k in REQUIRED:
            if k not in e:
                sys.stderr.write(json.dumps({
                    "ok": False,
                    "error": "entry_missing_field",
                    "index": idx,
                    "field": k,
                }) + "\n")
                sys.exit(65)
        prefill = str(e["prefill_pattern"])
        decode = str(e["decode_policy"])
        kernel = f"{prefill}__{decode}"
        out_entries.append({
            "layer": int(e["layer"]),
            "head": int(e["head"]),
            "kernel": kernel,
            "prefill_pattern": prefill,
            "decode_policy": decode,
        })
        by_kernel[kernel] = by_kernel.get(kernel, 0) + 1

    result = {
        "tsac_version": "w721-v1",
        "task": task_name,
        "num_layers": wrapper.get("num_layers"),
        "num_heads": wrapper.get("num_heads"),
        "entries": out_entries,
        "summary": {
            "total": len(out_entries),
            "by_kernel": by_kernel,
        },
    }

    encoded = json.dumps(result, indent=2, sort_keys=True)

    if args.output:
        try:
            os.makedirs(os.path.dirname(os.path.abspath(args.output)) or ".", exist_ok=True)
            with open(args.output, "w", encoding="utf-8") as fh:
                fh.write(encoded + "\n")
        except OSError as exc:
            sys.stderr.write(json.dumps({
                "ok": False,
                "error": "output_write_failed",
                "detail": str(exc),
            }) + "\n")
            sys.exit(73)

    sys.stdout.write(encoded + "\n")
    sys.exit(0)


if __name__ == "__main__":
    main()
