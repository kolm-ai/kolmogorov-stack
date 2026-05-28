#!/usr/bin/env python3
"""Scrub <think>...</think> blocks from teacher_output in a JSONL of training pairs.

Why: DeepSeek-R1-Distill emits chain-of-thought reasoning that the chat template
closes with </think> (often without an opening <think>). If those rows are kept
verbatim, the student learns to leak CoT prefixes on non-reasoning queries.

Rule (covers both shapes):
  1. If '</think>' is present: drop everything up to and including the LAST
     '</think>' marker, then lstrip the remainder.
  2. Else if '<think>' is present without close (rare; OpenAI o1 style): drop
     the entire row — there's no clean "final answer" to extract.
  3. Else pass through unchanged.

Idempotent: re-running on a scrubbed file is a no-op.

Usage:
  python scrub_think.py --in <pairs.jsonl> --out <clean.jsonl>
  python scrub_think.py --in <dir> --out <dir>  # walks *.jsonl
  python scrub_think.py --in <pairs.jsonl> --in-place
"""

import argparse
import json
import os
import sys

# T1.7 — shared UTF-8 console shim (was a 5-line copy here).
from _console import setup_utf8 as _setup_utf8  # noqa: F401 — import side-effect


def scrub(text: str) -> tuple[str, str]:
    """Return (cleaned_text, action) where action ∈ {'pass','closed','open_no_close'}."""
    if "</think>" in text:
        return text.rsplit("</think>", 1)[1].lstrip(), "closed"
    if "<think>" in text:
        return text, "open_no_close"  # caller decides to drop
    return text, "pass"


def process_file(in_path, out_path):
    n = closed = passed = dropped = 0
    with open(in_path, "r", encoding="utf-8") as f, open(out_path, "w", encoding="utf-8") as out:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            if "teacher_output" not in row:
                continue
            n += 1
            cleaned, action = scrub(row["teacher_output"])
            if action == "open_no_close":
                dropped += 1
                continue  # drop the row entirely
            if action == "closed":
                closed += 1
            else:
                passed += 1
            if not cleaned:
                dropped += 1
                continue  # post-strip empty row is useless
            row["teacher_output"] = cleaned
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
    return n, closed, passed, dropped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True, help="input JSONL or directory")
    ap.add_argument("--out", help="output JSONL or directory (omit when --in-place)")
    ap.add_argument("--in-place", action="store_true", help="overwrite input (creates .bak)")
    args = ap.parse_args()

    if args.in_place and not args.out:
        targets = []
        if os.path.isdir(args.inp):
            for root, _, files in os.walk(args.inp):
                for f in files:
                    if f.endswith(".jsonl"):
                        targets.append(os.path.join(root, f))
        else:
            targets = [args.inp]
        for t in targets:
            bak = t + ".bak"
            if not os.path.exists(bak):
                os.replace(t, bak)
            else:
                # already backed up; read .bak as canonical source
                pass
            n, closed, passed, dropped = process_file(bak, t)
            print(f"[scrub] {t}: in={n}  closed={closed}  pass={passed}  dropped={dropped}")
        return

    if not args.out:
        sys.stderr.write("[scrub] need --out or --in-place\n")
        sys.exit(2)

    if os.path.isdir(args.inp):
        if not os.path.isdir(args.out):
            os.makedirs(args.out, exist_ok=True)
        for f in os.listdir(args.inp):
            if not f.endswith(".jsonl"):
                continue
            ip = os.path.join(args.inp, f)
            op = os.path.join(args.out, f)
            n, closed, passed, dropped = process_file(ip, op)
            print(f"[scrub] {ip} -> {op}: in={n}  closed={closed}  pass={passed}  dropped={dropped}")
    else:
        n, closed, passed, dropped = process_file(args.inp, args.out)
        print(f"[scrub] {args.inp} -> {args.out}: in={n}  closed={closed}  pass={passed}  dropped={dropped}")


if __name__ == "__main__":
    main()
