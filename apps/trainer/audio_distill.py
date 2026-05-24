"""
apps/trainer/audio_distill.py

W772 - Audio distillation trainer entrypoint (transcript + intent).

This module is the W772 atomic implementation of the audio-distill pipeline
the planner anchors at line 629 of KOLM_W707_SYSTEM_UPGRADE_PLAN.md. It is
deliberately distinct from `apps/trainer/audio.py` (the Whisper LoRA
acoustic fine-tuner) because the W772 trainer's job is NOT to re-train the
acoustic encoder - it is to distill a teacher LLM's behavior conditioned on
the user's whisper-transcribed audio captures so the student speaks the
operator's domain accurately given a transcribed voice prompt.

Two-stage pipeline (live mode, NOT exercised by --dry-run):

  Stage A: pre-transcription.
    For every capture row that has an `audio_url` or `audio_base64` field
    but no `whisper_transcript`, run openai-whisper locally to extract a
    transcript. The transcript is stamped onto the row as
    `whisper_transcript_w772` (we do NOT overwrite a user-supplied
    `whisper_transcript`).

  Stage B: teacher distillation.
    For every transcribed capture, prompt the teacher model with the
    transcript text + an intent classification preamble, and persist the
    teacher's (transcript -> response) pair as a distill training row.

DRY-RUN MODE is the only mode this stdlib-only module supports end-to-end.
Live mode requires openai-whisper + torch + transformers and is gated on
those imports succeeding. The honesty contract is:

  - If torch is missing             -> exit 3 + ok:false torch_not_available
  - If --captures has zero audio    -> exit 4 + ok:false no_audio_captures
  - If whisper cannot load          -> exit 5 + ok:false whisper_load_failed
  - If teacher cannot load          -> exit 6 + ok:false teacher_load_failed
  - If args are malformed           -> exit 2 + ok:false bad_input
  - Otherwise                       -> exit 0 + ok:true

NEVER fabricate training results. NEVER claim a model trained when no
model was loaded. The dry-run envelope always carries trainer_not_invoked:
true so a downstream consumer cannot mistake a parse for a training run.

Stdlib-only (json + argparse + pathlib + sys + os) on the dry-run path so
this file is importable + runnable on a barebones Python install without
the heavy ML deps the live mode needs. The live-mode imports are wrapped
in try/except and gated by --dry-run.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from pathlib import Path


VERSION = "w772-v1"


# Exit-code contract. Pinned by tests/wave772-audio-distill.test.js and the
# CLI bakeoff harness so callers can branch deterministically on the
# audio-distill outcome.
EXIT_OK = 0
EXIT_BAD_INPUT = 2
EXIT_TORCH_NOT_AVAILABLE = 3
EXIT_NO_AUDIO_CAPTURES = 4
EXIT_WHISPER_LOAD_FAILED = 5
EXIT_TEACHER_LOAD_FAILED = 6


# Whisper checkpoint sizes we will honor on the --whisper-model flag. The
# default is `base` because it is the smallest model that produces usable
# domain transcripts; `large-v3` is the operator's escape hatch for
# accented speech or noisy field recordings.
WHISPER_CHOICES = ["tiny", "base", "small", "medium", "large-v3"]


def _emit(envelope: dict) -> None:
    """Print the envelope as a single JSON object on stdout.

    Stdout is the contract surface for downstream consumers (the W772 Node
    bakeoff harness in src/audio-bakeoff.js shells out to this script and
    reads the envelope from stdout). Logs / progress lines belong on
    stderr - we never mix them with the JSON envelope.
    """

    sys.stdout.write(json.dumps(envelope, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _bad_input(message: str, *, hint: str | None = None) -> int:
    env = {
        "ok": False,
        "error": "bad_input",
        "message": message,
        "version": VERSION,
    }
    if hint:
        env["hint"] = hint
    _emit(env)
    return EXIT_BAD_INPUT


def _load_captures(path: str) -> list[dict]:
    """Read the JSONL capture file. Each line must be a JSON object.

    Bad lines (malformed JSON, non-object) are surfaced via bad_input - we
    never silently drop a row because a single dropped row in a distill
    set is a silent training-data leak.
    """

    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"captures file not found: {path}")
    rows: list[dict] = []
    with p.open("r", encoding="utf-8") as f:
        for line_no, raw in enumerate(f, 1):
            line = raw.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                raise ValueError(
                    f"malformed JSON at {path}:{line_no}: {e.msg}"
                ) from e
            if not isinstance(obj, dict):
                raise ValueError(
                    f"non-object capture row at {path}:{line_no}; got "
                    f"{type(obj).__name__}"
                )
            rows.append(obj)
    return rows


def _classify_capture(row: dict) -> dict:
    """Return per-row presence flags for whisper / url / base64 fields.

    Pure inspection - no I/O, no network. The W772 dry-run envelope folds
    these counts into a summary the operator can sanity-check before
    paying for the live transcription + teacher round-trip.
    """

    transcript = row.get("whisper_transcript")
    has_transcript = bool(isinstance(transcript, str) and transcript.strip())
    audio_url = row.get("audio_url")
    has_url = bool(isinstance(audio_url, str) and audio_url.strip())
    audio_b64 = row.get("audio_base64")
    has_b64 = bool(isinstance(audio_b64, str) and audio_b64.strip())
    return {
        "has_transcript": has_transcript,
        "has_audio_url": has_url,
        "has_audio_base64": has_b64,
    }


def _summarize(rows: list[dict]) -> dict:
    """Aggregate the per-row flags into a dry-run-safe summary."""

    audio_count = 0
    transcript_count = 0
    url_count = 0
    base64_count = 0
    for row in rows:
        flags = _classify_capture(row)
        if (
            flags["has_transcript"]
            or flags["has_audio_url"]
            or flags["has_audio_base64"]
        ):
            audio_count += 1
        if flags["has_transcript"]:
            transcript_count += 1
        if flags["has_audio_url"]:
            url_count += 1
        if flags["has_audio_base64"]:
            base64_count += 1
    return {
        "rows_total": len(rows),
        "audio_captures_total": audio_count,
        "captures_with_transcript": transcript_count,
        "captures_with_audio_url": url_count,
        "captures_with_base64": base64_count,
    }


def _torch_available() -> bool:
    """Cheap probe - we never *need* torch on the dry-run path."""

    try:
        import torch  # noqa: F401
        return True
    except Exception:
        return False


def _write_run_meta(
    out_path: str | None,
    envelope: dict,
) -> str | None:
    """Persist the dry-run envelope to disk when --out is supplied.

    Returns the resolved path so the envelope can stamp it under
    `out_path` for the test harness. Pure I/O - no side effect on the
    envelope object the caller passed in.
    """

    if not out_path:
        return None
    p = Path(out_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(envelope, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(p.resolve())


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="audio_distill",
        description=(
            "W772 - audio distill trainer (transcript + intent). "
            "Stdlib-only on --dry-run; live mode needs openai-whisper + torch."
        ),
    )
    parser.add_argument(
        "--captures",
        required=True,
        help="JSONL of audio capture rows (audio_url|audio_base64|whisper_transcript per row).",
    )
    parser.add_argument(
        "--out",
        default=None,
        help="Path for the run-meta.json envelope.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse-and-summarize only. No torch/whisper/teacher import.",
    )
    parser.add_argument(
        "--whisper-model",
        choices=WHISPER_CHOICES,
        default="base",
        help="Whisper checkpoint to use in live mode (ignored on --dry-run).",
    )
    parser.add_argument(
        "--teacher-model",
        default="anthropic/claude-opus-4-7",
        help="Teacher LLM id to distill from (ignored on --dry-run).",
    )
    parser.add_argument(
        "--max-samples",
        type=int,
        default=0,
        help="Cap the number of capture rows processed (0 = no cap).",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    try:
        args = _parse_args(argv)
    except SystemExit as e:
        # argparse already wrote its own usage; surface a bad-input envelope
        # so a JSON-only consumer sees the contract failure instead of an
        # empty stdout.
        if e.code == 0:
            return EXIT_OK
        return _bad_input(
            "argparse rejected the argv",
            hint="run `python audio_distill.py --help` for usage",
        )

    # Captures file must parse before we even consider torch availability.
    try:
        rows = _load_captures(args.captures)
    except FileNotFoundError as e:
        return _bad_input(str(e), hint="pass an existing JSONL via --captures")
    except ValueError as e:
        return _bad_input(str(e), hint="each capture row must be a JSON object on its own line")

    if args.max_samples and args.max_samples > 0:
        rows = rows[: args.max_samples]

    summary = _summarize(rows)

    if summary["audio_captures_total"] == 0:
        envelope = {
            "ok": False,
            "error": "no_audio_captures",
            "message": (
                "no rows in the supplied captures had whisper_transcript, "
                "audio_url, or audio_base64."
            ),
            "hint": (
                "verify the upstream wrapper is passing through "
                "OpenAI-shape `input_audio` content blocks or "
                "whisper_transcript fields."
            ),
            "rows_total": summary["rows_total"],
            "audio_captures_total": 0,
            "version": VERSION,
        }
        _write_run_meta(args.out, envelope)
        _emit(envelope)
        return EXIT_NO_AUDIO_CAPTURES

    if args.dry_run:
        envelope = {
            "ok": True,
            "mode": "dry_run",
            "rows_total": summary["rows_total"],
            "audio_captures_total": summary["audio_captures_total"],
            "captures_with_transcript": summary["captures_with_transcript"],
            "captures_with_audio_url": summary["captures_with_audio_url"],
            "captures_with_base64": summary["captures_with_base64"],
            "whisper_model": args.whisper_model,
            "teacher_model": args.teacher_model,
            "max_samples": args.max_samples,
            "trainer_not_invoked": True,
            "hint": "pip install openai-whisper torch transformers",
            "version": VERSION,
        }
        out_path = _write_run_meta(args.out, envelope)
        if out_path:
            envelope["out_path"] = out_path
            # Re-write the envelope on disk so the persisted file reflects
            # the resolved path (idempotent).
            _write_run_meta(args.out, envelope)
        _emit(envelope)
        return EXIT_OK

    # --- Live mode below this line. We intentionally make the first
    # failure mode (torch missing) honest + machine-readable so the
    # operator sees the exact `pip install` command. We do NOT try to be
    # clever about which torch wheel to install - the operator picks the
    # CUDA/CPU wheel that matches their hardware.

    if not _torch_available():
        envelope = {
            "ok": False,
            "error": "torch_not_available",
            "message": (
                "torch is not importable in this environment; live audio "
                "distill is blocked."
            ),
            "hint": "pip install torch (pick the CUDA/CPU wheel for your hardware)",
            "version": VERSION,
        }
        _write_run_meta(args.out, envelope)
        _emit(envelope)
        return EXIT_TORCH_NOT_AVAILABLE

    try:
        import whisper  # type: ignore
    except Exception as e:
        envelope = {
            "ok": False,
            "error": "whisper_load_failed",
            "message": f"openai-whisper import failed: {e}",
            "hint": "pip install -U openai-whisper",
            "version": VERSION,
        }
        _write_run_meta(args.out, envelope)
        _emit(envelope)
        return EXIT_WHISPER_LOAD_FAILED

    try:
        import transformers  # type: ignore  # noqa: F401
    except Exception as e:
        envelope = {
            "ok": False,
            "error": "teacher_load_failed",
            "message": f"transformers import failed: {e}",
            "hint": "pip install -U transformers",
            "version": VERSION,
        }
        _write_run_meta(args.out, envelope)
        _emit(envelope)
        return EXIT_TEACHER_LOAD_FAILED

    # Live mode body is intentionally a stub at this revision - the W772
    # wave atomically lands the harness + envelope contract; the teacher
    # round-trip will land in a follow-up commit once the streaming
    # whisper bridge is wired in `apps/trainer/audio.py`.
    envelope = {
        "ok": True,
        "mode": "live_stub",
        "rows_total": summary["rows_total"],
        "audio_captures_total": summary["audio_captures_total"],
        "captures_with_transcript": summary["captures_with_transcript"],
        "captures_with_audio_url": summary["captures_with_audio_url"],
        "captures_with_base64": summary["captures_with_base64"],
        "whisper_model": args.whisper_model,
        "teacher_model": args.teacher_model,
        "max_samples": args.max_samples,
        "trainer_not_invoked": True,
        "message": (
            "live mode stub - whisper + transformers loaded but the teacher "
            "round-trip is staged in a follow-up; envelope returned for "
            "harness compatibility."
        ),
        "version": VERSION,
    }
    out_path = _write_run_meta(args.out, envelope)
    if out_path:
        envelope["out_path"] = out_path
        _write_run_meta(args.out, envelope)
    _emit(envelope)
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
