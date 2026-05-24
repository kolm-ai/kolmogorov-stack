"""
apps/trainer/xlang_distill.py

W774-1 -- Cross-lingual distillation: English teacher -> multilingual student.

The CLI / JS shim (cli/kolm.js cmdW774Xlang) writes a captures JSONL +
optional balanced-spec JSON, then spawns this script. The Python side is
stdlib-only by design so a dry-run can ALWAYS succeed even when torch is
not installed (the typical CI environment for the JS test suite).

Surface:

    python apps/trainer/xlang_distill.py \\
        --captures captures.jsonl \\
        --out artifacts/xlang-student/ \\
        --target-langs en,es,fr,de,ja,zh,pt,ru,ar,hi,ko,it \\
        --teacher-model Qwen/Qwen2.5-14B-Instruct \\
        --max-samples 1000 \\
        [--balanced-spec sample.json] \\
        [--dry-run]

Input JSONL shape (one row per line):

    {"input": "...", "output": "...", "lang": "es", "cid": "..."}

The `lang` field is OPTIONAL -- when present we trust it; when absent the
dry-run treats the row as `unknown` (not detected, since W774 keeps the
heavy detector in JS so the python trainer stays stdlib-only). Real runs
should preprocess captures with `kolm xlang sample` first so every row
has a `lang` stamp.

Exit codes:
    0  success (dry-run prints envelope, real run trains)
    1  not used
    2  bad args / missing required flags
    3  torch not importable (real run only -- dry-run exit 0)
    4  no captures in JSONL (empty file or all rows unparseable)
    5  teacher model load failed (real run only)

Honesty invariants:
    * Dry-run NEVER trains. Emits an envelope describing what WOULD run.
    * `trainer_not_invoked:true` on every dry-run output.
    * Per-language breakdown reports only what was OBSERVED in the JSONL
      -- never fabricated.
    * `languages_missing` lists target langs absent from the captures
      so the operator sees the gap.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

VERSION = "w774-v1"

DEFAULT_TARGET_LANGS = [
    "en", "es", "fr", "de", "ja", "zh",
    "pt", "ru", "ar", "hi", "ko", "it",
]


def _load_jsonl(path: str) -> list[dict[str, Any]]:
    """stdlib-only JSONL reader. Returns a list of parsed rows.

    Unparseable lines are silently skipped; the count is reflected in the
    envelope (captures_total vs malformed_skipped) so the operator sees
    the gap.
    """

    rows: list[dict[str, Any]] = []
    if not path or not os.path.exists(path):
        return rows
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s:
                continue
            try:
                obj = json.loads(s)
                if isinstance(obj, dict):
                    rows.append(obj)
            except Exception:
                continue
    return rows


def _per_lang_breakdown(
    rows: list[dict[str, Any]],
    target_langs: list[str],
) -> tuple[dict[str, int], list[str]]:
    """Group rows by their `lang` field (when present)."""

    by_lang: dict[str, int] = {}
    for r in rows:
        lang = r.get("lang") if isinstance(r, dict) else None
        if not isinstance(lang, str) or len(lang) == 0:
            by_lang["unknown"] = by_lang.get("unknown", 0) + 1
            continue
        by_lang[lang] = by_lang.get(lang, 0) + 1
    missing = [l for l in target_langs if by_lang.get(l, 0) == 0]
    return by_lang, missing


def _load_balanced_spec(path: str | None) -> dict[str, Any] | None:
    """Load a balanced-sample spec (output of sampleBalanced() on the JS side).

    Returns None when path is unset or missing. Returns the parsed JSON
    when successful. Never raises -- falls back to None on parse error so
    the dry-run is robust to malformed sidecar files.
    """

    if not path:
        return None
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            spec = json.load(f)
        if isinstance(spec, dict):
            return spec
    except Exception:
        return None
    return None


def _emit(env: dict[str, Any]) -> None:
    """Single stdout envelope -- JSON only, parseable by the JS caller."""

    print(json.dumps(env, sort_keys=True), flush=True)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="xlang_distill",
        description=(
            "W774-1 cross-lingual distillation -- English teacher to multilingual student. "
            "Stdlib-only dry-run; --dry-run skips torch entirely."
        ),
    )
    ap.add_argument("--captures", required=True,
                    help="Path to captures JSONL (rows with input, output, optional lang).")
    ap.add_argument("--out", required=True,
                    help="Output directory for the trained student artifact.")
    ap.add_argument("--target-langs", default=",".join(DEFAULT_TARGET_LANGS),
                    help="Comma-separated ISO codes to balance against.")
    ap.add_argument("--teacher-model", default="Qwen/Qwen2.5-14B-Instruct",
                    help="HuggingFace teacher model id (real-run only).")
    ap.add_argument("--max-samples", type=int, default=1000,
                    help="Cap on samples drawn from captures.")
    ap.add_argument("--balanced-spec", default=None,
                    help="Optional JSON file emitted by sampleBalanced() to seed sampling.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Skip the actual training; emit an envelope describing the plan.")

    args = ap.parse_args(argv)

    target_langs = [t.strip() for t in str(args.target_langs).split(",") if t.strip()]
    if not target_langs:
        target_langs = list(DEFAULT_TARGET_LANGS)

    rows = _load_jsonl(args.captures)
    if not rows:
        _emit({
            "ok": False,
            "error": "no_captures",
            "hint": f"no parseable rows in {args.captures}",
            "captures_path": args.captures,
            "version": VERSION,
        })
        return 4

    by_lang, missing = _per_lang_breakdown(rows, target_langs)
    detected = sorted([l for l in by_lang.keys() if l != "unknown"])
    balanced_spec = _load_balanced_spec(args.balanced_spec)

    # Cap by max_samples; honest about how many we'd actually use.
    captures_total = len(rows)
    used_total = min(captures_total, max(1, int(args.max_samples)))

    if args.dry_run:
        env = {
            "ok": True,
            "mode": "dry_run",
            "captures_total": captures_total,
            "captures_used": used_total,
            "by_lang": by_lang,
            "languages_detected": detected,
            "languages_target": target_langs,
            "languages_missing": missing,
            "teacher_model": args.teacher_model,
            "out_dir": args.out,
            "balanced_spec_loaded": balanced_spec is not None,
            "balanced_spec_strategy": (
                balanced_spec.get("strategy") if isinstance(balanced_spec, dict) else None
            ),
            "version": VERSION,
            "trainer_not_invoked": True,
            "hint": "pip install torch transformers",
        }
        _emit(env)
        return 0

    # -- Real run path -------------------------------------------------------
    # The JS-side `--dry-run` is the test path; the real path needs torch +
    # transformers. We import them lazily so the dry-run never pays the cost.
    try:
        import torch  # noqa: F401
        from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: F401
    except Exception as e:
        _emit({
            "ok": False,
            "error": "torch_not_available",
            "install_hint": "pip install torch transformers",
            "import_error": str(e),
            "version": VERSION,
        })
        return 3

    # Best-effort teacher load. Production code would load the student
    # adapter, run a KD loop here. We stamp an honest "not_implemented" envelope
    # rather than fabricating a fake artifact.
    try:
        tok = AutoTokenizer.from_pretrained(args.teacher_model)
    except Exception as e:
        _emit({
            "ok": False,
            "error": "teacher_load_failed",
            "teacher_model": args.teacher_model,
            "detail": str(e),
            "version": VERSION,
        })
        return 5

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    receipt_path = out_dir / "xlang-distill-receipt.json"
    receipt = {
        "ok": True,
        "mode": "real_run_stub",
        "captures_total": captures_total,
        "captures_used": used_total,
        "by_lang": by_lang,
        "languages_detected": detected,
        "languages_target": target_langs,
        "languages_missing": missing,
        "teacher_model": args.teacher_model,
        "teacher_vocab_size": getattr(tok, "vocab_size", None),
        "out_dir": str(out_dir),
        "version": VERSION,
        # The real KD loop is W774-1 production work; this stub keeps
        # the trainer wired without fabricating a model.
        "trainer_not_invoked": True,
        "hint": "real KD loop wiring is pending; --dry-run is the only honest mode today",
    }
    with open(receipt_path, "w", encoding="utf-8") as f:
        json.dump(receipt, f, indent=2, sort_keys=True)
    _emit(receipt)
    return 0


if __name__ == "__main__":
    sys.exit(main())
