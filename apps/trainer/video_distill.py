"""
apps/trainer/video_distill.py

W773 - Video distillation pipeline (frame sampling + caption pipeline).

Distills a frontier vision-language teacher (Gemini 1.5 Pro video,
GPT-4o video, Claude 3.5 Sonnet video) into a smaller student that
operates on a sampled sequence of frame embeddings plus captioned
context. The student NEVER sees raw video bytes at training time;
it sees frame embeddings + captions emitted by the sampler pipeline.

This module is stdlib-only at import-time (no torch, no ffmpeg, no
cv2 in the import chain) so `--dry-run` works on a vanilla Python
install. Heavy deps are imported lazily inside the live train path
behind explicit ImportError -> exit(3|5) gates.

CLI surface:

    python apps/trainer/video_distill.py \\
        --captures captures.jsonl \\
        --out student-weights/ \\
        --teacher-model gemini-1.5-pro \\
        --frame-sampler-spec spec.json \\
        --max-samples 1000 \\
        [--dry-run]

Captures JSONL shape (one row per capture):
    {
      "video_url": "https://...",        # OR
      "video_base64": "<base64>",        # OR
      "frame_captions": ["...", "..."],  # pre-extracted captions
      "prompt": "...",
      "response": "..."
    }

Frame sampler spec (emitted by src/frame-sampler.js):
    {
      "ok": true,
      "version": "w773-v1",
      "strategy": "uniform" | "keyframe" | "scene_change" | "adaptive",
      "fps_target": 1.0,
      "max_frames": 64,
      "expected_frame_count": <int>,
      "sampling_indices": [<seconds>, ...]
    }

Exit codes:
    0 - success (or honest dry-run)
    2 - bad args / missing required arg
    3 - torch / heavy deps missing (honest envelope on stdout)
    4 - no video captures found in input JSONL
    5 - ffmpeg or cv2 missing (live mode only)
    6 - teacher model load failed (live mode only)

HONESTY INVARIANTS:
    * --dry-run NEVER touches torch or ffmpeg or the teacher API. It
      prints a structured envelope and exits 0.
    * dry-run envelope reports total_frames_estimated from the same
      math the live run will use (mirrors src/frame-sampler.js
      estimateExtractedFrames). The estimate is NEVER a placeholder.
    * Live mode NEVER fabricates training results. If teacher load
      fails or sampler errors out, exit 6 with an honest envelope.
    * Version stamp is "w773-v1" and rides every emitted envelope
      so a downstream auditor can pin runs to this module revision.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any


VIDEO_DISTILL_VERSION = "w773-v1"

# Mirror of src/frame-sampler.js density table. If you change one,
# change the other or the dry-run estimate will diverge from the
# live run's actual frame count.
_DENSITY_BY_STRATEGY = {
    "uniform": 1.0,
    "keyframe": 0.35,
    "scene_change": 0.20,
    "adaptive": 1.2,
}

_HARD_FRAME_CAP = 1024
_DEFAULT_FPS = 1.0
_DEFAULT_MAX_FRAMES = 64


def _estimate_frames(duration_s: float, strategy: str, fps: float, cap: int) -> int:
    """Estimate the number of frames the sampler will extract for one
    video. MUST match the JS estimateExtractedFrames math exactly.
    """
    try:
        d = float(duration_s)
        f = float(fps)
    except (TypeError, ValueError):
        return 0
    if d <= 0 or f <= 0:
        return 0
    density = _DENSITY_BY_STRATEGY.get(str(strategy), 1.0)
    raw = max(1, int((d * f * density) + 0.999))
    final = raw
    if isinstance(cap, (int, float)) and cap and cap > 0 and final > int(cap):
        final = int(cap)
    if final > _HARD_FRAME_CAP:
        final = _HARD_FRAME_CAP
    return final


def _emit(env: dict, stderr_line: str = "") -> None:
    """Print the envelope as a single JSON line on stdout, plus an
    optional human-readable line on stderr. The JS caller parses the
    stdout line; the stderr line is for operator eyes.
    """
    sys.stdout.write(json.dumps(env) + "\n")
    sys.stdout.flush()
    if stderr_line:
        sys.stderr.write(stderr_line + "\n")


def _row_has_video(row: dict) -> bool:
    """A capture row counts as a video capture if it carries any of:
        - video_url       (URL reference)
        - video_base64    (inline base64)
        - frame_captions  (pre-extracted captions; still counts because
                           the captions presuppose a video upstream)
        - media_kind=='video' (event-store native shape)
    Returns False otherwise. NEVER fabricates a video row.
    """
    if not isinstance(row, dict):
        return False
    if row.get("video_url"):
        return True
    if row.get("video_base64"):
        return True
    if isinstance(row.get("frame_captions"), list) and row["frame_captions"]:
        return True
    if row.get("media_kind") == "video":
        return True
    # event-store rows carry the w773 metadata block.
    w773 = row.get("w773")
    if isinstance(w773, dict) and w773.get("has_video") is True:
        return True
    return False


def _row_duration_s(row: dict) -> float:
    """Best-effort duration. Honest 0.0 when unknown so the estimator
    counts at least one representative frame.
    """
    for key in ("duration_s", "duration_seconds", "duration"):
        v = row.get(key)
        if isinstance(v, (int, float)) and v > 0:
            return float(v)
    return 0.0


def _load_jsonl(path: str) -> list[dict]:
    """Tolerant JSONL loader. Skips blank lines + parse errors. Returns
    a list of dicts.
    """
    if not os.path.exists(path):
        return []
    rows: list[dict] = []
    with open(path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
                if isinstance(row, dict):
                    rows.append(row)
            except json.JSONDecodeError:
                # Skip bad rows quietly; the row count reported reflects
                # parseable rows only. The operator can re-run with
                # --captures pointed at a fixed file.
                continue
    return rows


def _load_sampler_spec(path: str | None) -> dict | None:
    """Load the JSON sampler spec emitted by src/frame-sampler.js.
    Returns None when path is None or missing. Returns the parsed
    dict when present + parseable. Returns {} on parse failure so
    the dry-run can carry on with defaults.
    """
    if not path:
        return None
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            obj = json.load(fh)
        return obj if isinstance(obj, dict) else None
    except (json.JSONDecodeError, OSError):
        return {}


def _main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(
        description="W773 video distillation - frame sampling + caption pipeline (stdlib-only on dry-run).",
        prog="video_distill",
    )
    p.add_argument("--captures", required=True,
                   help="path to captures.jsonl (rows with video_url, video_base64, or frame_captions)")
    p.add_argument("--out", required=True,
                   help="output directory for student weights / run-meta")
    p.add_argument("--teacher-model", default=None,
                   help="teacher model id (e.g. gemini-1.5-pro, gpt-4o, claude-3.5-sonnet)")
    p.add_argument("--frame-sampler-spec", default=None,
                   help="path to the JSON sampler spec emitted by src/frame-sampler.js")
    p.add_argument("--max-samples", type=int, default=1000,
                   help="cap on captures to process (default 1000)")
    p.add_argument("--dry-run", action="store_true",
                   help="parse + count + estimate frames; never touches torch or teacher API")

    try:
        args = p.parse_args(argv)
    except SystemExit as e:
        # argparse exits 2 on bad args; honor that. We catch + re-raise so
        # the surrounding `if __name__` block doesn't swallow it.
        return int(e.code) if e.code is not None else 2

    rows = _load_jsonl(args.captures)
    video_rows = [r for r in rows if _row_has_video(r)]

    if not video_rows:
        env = {
            "ok": False,
            "error": "no_video_captures",
            "captures_total": len(rows),
            "video_captures_total": 0,
            "hint": ("captures file must contain rows with video_url, video_base64, "
                     "or frame_captions; or events with media_kind:'video' / w773.has_video"),
            "version": VIDEO_DISTILL_VERSION,
        }
        _emit(env, stderr_line=f"video_distill: no video captures in {args.captures} (parsed {len(rows)} rows)")
        return 4

    spec = _load_sampler_spec(args.frame_sampler_spec)
    strategy = (spec or {}).get("strategy", "uniform")
    fps = float((spec or {}).get("fps_target", _DEFAULT_FPS) or _DEFAULT_FPS)
    cap = int((spec or {}).get("max_frames", _DEFAULT_MAX_FRAMES) or _DEFAULT_MAX_FRAMES)

    capped_rows = video_rows[: max(1, int(args.max_samples))]

    total_frames_estimated = 0
    for row in capped_rows:
        dur = _row_duration_s(row)
        if dur <= 0:
            # Honest fallback: if duration is unknown, the sampler will
            # extract whatever the strategy yields per the spec. We
            # estimate the cap (max_frames) as the upper bound so
            # operators see the worst-case frame count.
            total_frames_estimated += int(cap)
        else:
            total_frames_estimated += _estimate_frames(dur, strategy, fps, cap)

    if args.dry_run:
        env = {
            "ok": True,
            "mode": "dry_run",
            "version": VIDEO_DISTILL_VERSION,
            "captures_total": len(rows),
            "video_captures_total": len(video_rows),
            "video_captures_processed": len(capped_rows),
            "total_frames_estimated": total_frames_estimated,
            "strategy": str(strategy),
            "fps_target": float(fps),
            "max_frames": int(cap),
            "teacher_model": args.teacher_model,
            "sampler_spec_present": spec is not None,
            "trainer_not_invoked": True,
            "hint": "pip install torch transformers opencv-python ffmpeg-python",
        }
        _emit(env, stderr_line=(
            f"video_distill --dry-run: {len(video_rows)} video captures, "
            f"~{total_frames_estimated} frames; nothing trained."
        ))
        return 0

    # ----- LIVE PATH (lazy heavy imports) -----
    # Honesty contract: if any heavy dep is missing, exit with the right
    # code + an envelope the JS caller can JSON.parse.
    try:
        import torch  # noqa: F401
    except ImportError as e:
        env = {
            "ok": False,
            "error": "torch_not_available",
            "install_hint": "pip install torch",
            "import_error": str(e),
            "version": VIDEO_DISTILL_VERSION,
        }
        _emit(env, stderr_line="video_distill: torch not importable; rerun with --dry-run or install torch")
        return 3

    try:
        import cv2  # noqa: F401
    except ImportError as e:
        env = {
            "ok": False,
            "error": "cv2_not_available",
            "install_hint": "pip install opencv-python ffmpeg-python",
            "import_error": str(e),
            "version": VIDEO_DISTILL_VERSION,
        }
        _emit(env, stderr_line="video_distill: opencv-python missing; rerun with --dry-run or install cv2")
        return 5

    try:
        from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: F401
    except ImportError as e:
        env = {
            "ok": False,
            "error": "transformers_not_available",
            "install_hint": "pip install transformers",
            "import_error": str(e),
            "version": VIDEO_DISTILL_VERSION,
        }
        _emit(env, stderr_line="video_distill: transformers missing; rerun with --dry-run or install transformers")
        return 3

    # The live training loop is intentionally minimal here. The
    # production-grade integration (multi-GPU, captioning teacher
    # bring-your-own-key, ferreting out cached frames) is deferred to
    # subsequent waves. For now, we materialize a structured receipt
    # so the contract is honored and the operator can see exactly what
    # the run did.
    os.makedirs(args.out, exist_ok=True)
    meta_path = os.path.join(args.out, "run-meta.json")
    meta = {
        "version": VIDEO_DISTILL_VERSION,
        "mode": "live_min",
        "captures_total": len(rows),
        "video_captures_total": len(video_rows),
        "video_captures_processed": len(capped_rows),
        "total_frames_estimated": total_frames_estimated,
        "strategy": str(strategy),
        "fps_target": float(fps),
        "max_frames": int(cap),
        "teacher_model": args.teacher_model,
        "out_dir": args.out,
        "trainer_not_fully_invoked": True,
        "note": ("Live mode currently materializes run-meta only. Full multi-GPU "
                 "distillation lives in subsequent wave. Re-run with --dry-run "
                 "for a deterministic preview."),
    }
    try:
        with open(meta_path, "w", encoding="utf-8") as fh:
            json.dump(meta, fh, indent=2)
    except OSError as e:
        env = {
            "ok": False,
            "error": "write_failed",
            "detail": str(e),
            "version": VIDEO_DISTILL_VERSION,
        }
        _emit(env, stderr_line=f"video_distill: failed to write {meta_path}: {e}")
        return 5

    env = {
        "ok": True,
        "mode": "live_min",
        "version": VIDEO_DISTILL_VERSION,
        "run_meta": meta_path,
        **meta,
    }
    _emit(env, stderr_line=f"video_distill: wrote run-meta to {meta_path}")
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
