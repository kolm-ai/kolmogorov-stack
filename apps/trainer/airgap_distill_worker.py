#!/usr/bin/env python3
"""Consume one queued air-gap distillation spec.

This worker is intentionally small. The JavaScript control plane owns queue
state, tenant attribution, redaction checks, and no-egress probing. This Python
process owns the actual ML execution boundary and delegates to
apps/trainer/distill.py so the air-gap path does not grow a second trainer.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any


AIRGAP_WORKER_VERSION = "w953-v1"
BLOCKED_ENV_KEYS = (
    "KOLM_TEACHER_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "MISTRAL_API_KEY",
    "TOGETHER_API_KEY",
    "FIREWORKS_API_KEY",
    "GROQ_API_KEY",
    "COHERE_API_KEY",
    "REPLICATE_API_TOKEN",
    "HF_TOKEN",
    "HUGGINGFACEHUB_API_TOKEN",
    "WANDB_API_KEY",
)
OFFLINE_ENV = {
    "KOLM_AIRGAP": "1",
    "TRANSFORMERS_OFFLINE": "1",
    "HF_DATASETS_OFFLINE": "1",
    "HF_HUB_OFFLINE": "1",
    "WANDB_DISABLED": "true",
    "TOKENIZERS_PARALLELISM": "false",
}
CONFIG_FIELDS = {
    "temperature",
    "alpha",
    "learning_rate",
    "lora_r",
    "lora_alpha",
    "max_length",
    "batch_size",
    "num_epochs",
    "eval_split",
    "seed",
}


class WorkerError(RuntimeError):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code


def _sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, indent=2, sort_keys=True))


def _load_spec(spec_path: Path) -> dict[str, Any]:
    try:
        data = json.loads(spec_path.read_text(encoding="utf-8"))
    except OSError as e:
        raise WorkerError("spec_read_error", str(e)) from e
    except json.JSONDecodeError as e:
        raise WorkerError("spec_parse_error", str(e)) from e
    if not isinstance(data, dict):
        raise WorkerError("spec_not_object", "air-gap distill spec must be a JSON object")
    return data


def _require_abs_existing(spec: dict[str, Any], key: str, file_required: bool = False) -> Path:
    value = spec.get(key)
    if not isinstance(value, str) or not value:
        raise WorkerError("spec_path_missing", f"{key} is required")
    if "://" in value:
        raise WorkerError("spec_path_not_local", f"{key} must be a local filesystem path")
    p = Path(value)
    if not p.is_absolute():
        raise WorkerError("spec_path_not_absolute", f"{key} must be absolute")
    if file_required and not p.is_file():
        raise WorkerError("spec_path_not_found", f"{key} file does not exist: {p}")
    if not file_required and not p.exists():
        raise WorkerError("spec_path_not_found", f"{key} does not exist: {p}")
    return p


def _validate_environment() -> None:
    leaked = [k for k in BLOCKED_ENV_KEYS if k in os.environ]
    if leaked:
        raise WorkerError(
            "airgap_secret_env_present",
            "cloud or telemetry credentials are present in worker env: " + ", ".join(sorted(leaked)),
        )
    for key, value in OFFLINE_ENV.items():
        os.environ[key] = value


def _validate_spec(spec: dict[str, Any]) -> tuple[Path, Path, Path, Path]:
    if spec.get("airgap_verified") is not True or spec.get("verification_method") != "no_network_dial":
        raise WorkerError("spec_not_airgap_verified", "spec must be airgap_verified via no_network_dial")
    redaction = spec.get("redaction")
    if not isinstance(redaction, dict) or redaction.get("applied") is not True:
        raise WorkerError("spec_redaction_missing", "spec must carry mandatory redaction evidence")
    if spec.get("redaction_policy") != "mandatory_training_redaction":
        raise WorkerError("spec_redaction_policy_invalid", "redaction_policy must be mandatory_training_redaction")

    train_jsonl = _require_abs_existing(spec, "user_data_path", file_required=True)
    teacher = _require_abs_existing(spec, "teacher_path_local")
    student = _require_abs_existing(spec, "student_path_local")
    output = Path(str(spec.get("output_path") or ""))
    if not output.is_absolute():
        raise WorkerError("spec_path_not_absolute", "output_path must be absolute")
    if not output.parent.exists():
        raise WorkerError("spec_path_not_found", f"output_path parent does not exist: {output.parent}")

    source = spec.get("source_user_data_path")
    if not isinstance(source, str) or Path(source).resolve() == train_jsonl.resolve():
        raise WorkerError("spec_raw_corpus_selected", "worker refuses to train on the source corpus path")
    redacted_sha = redaction.get("redacted_sha256")
    if isinstance(redacted_sha, str) and redacted_sha and _sha256_file(train_jsonl) != redacted_sha:
        raise WorkerError("spec_redacted_sha256_mismatch", "redacted corpus hash does not match spec")
    redacted_path = redaction.get("redacted_user_data_path")
    if isinstance(redacted_path, str) and Path(redacted_path).resolve() != train_jsonl.resolve():
        raise WorkerError("spec_redacted_path_mismatch", "redaction.redacted_user_data_path must match user_data_path")
    return train_jsonl, teacher, student, output


def _config_kwargs(spec: dict[str, Any]) -> dict[str, Any]:
    raw = spec.get("distill_config")
    if not isinstance(raw, dict):
        return {}
    return {k: raw[k] for k in CONFIG_FIELDS if k in raw}


def _receipt_only(spec: dict[str, Any], output: Path, train_jsonl: Path) -> dict[str, Any]:
    payload = {
        "ok": True,
        "mode": "receipt_only",
        "warning": "receipt_only does not perform gradient training; use default mode for KD training",
        "airgap_worker_version": AIRGAP_WORKER_VERSION,
        "run_id": spec.get("run_id"),
        "training_corpus_sha256": _sha256_file(train_jsonl),
        "teacher_path_local": str(spec.get("teacher_path_local")),
        "student_path_local": str(spec.get("student_path_local")),
    }
    if output.suffix:
        output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        payload["artifact_path"] = str(output)
    else:
        output.mkdir(parents=True, exist_ok=True)
        receipt_path = output / "airgap-distill-receipt.json"
        receipt_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        payload["artifact_path"] = str(receipt_path)
    payload["artifact_sha256"] = _sha256_file(Path(payload["artifact_path"]))
    return payload


def _train(spec: dict[str, Any], train_jsonl: Path, teacher: Path, student: Path, output: Path) -> dict[str, Any]:
    from distill import DistillConfig, KDObjective, distill_trainer, receipt_block

    kwargs = _config_kwargs(spec)
    objective = None
    raw_cfg = spec.get("distill_config")
    if isinstance(raw_cfg, dict) and isinstance(raw_cfg.get("objective"), str):
        objective = KDObjective.from_str(raw_cfg["objective"])
    cfg = DistillConfig(**kwargs)
    if objective is not None:
        cfg.objective = objective
    session = distill_trainer(
        teacher_model=str(teacher),
        student_model=str(student),
        train_jsonl=str(train_jsonl),
        out_dir=str(output),
        config=cfg,
    )
    summary = session.train()
    receipt = receipt_block(session, summary)
    receipt["airgap_worker_version"] = AIRGAP_WORKER_VERSION
    receipt["airgap_run_id"] = spec.get("run_id")
    receipt["airgap_training_corpus_sha256"] = _sha256_file(train_jsonl)
    receipt["distill_config"] = asdict(cfg) | {"objective": cfg.objective.value}
    return {
        "ok": True,
        "mode": "kd_trainer",
        "airgap_worker_version": AIRGAP_WORKER_VERSION,
        "run_id": spec.get("run_id"),
        "output_path": str(output),
        "receipt": receipt,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="airgap_distill_worker.py")
    ap.add_argument("--spec", required=True, help="Queued ~/.kolm/airgap-distill-runs/<id>.json spec")
    ap.add_argument(
        "--receipt-only",
        action="store_true",
        help="Validate the spec and write an audit receipt without gradient training. For diagnostics/tests only.",
    )
    args = ap.parse_args(argv)
    try:
        _validate_environment()
        spec = _load_spec(Path(args.spec))
        train_jsonl, teacher, student, output = _validate_spec(spec)
        payload = _receipt_only(spec, output, train_jsonl) if args.receipt_only else _train(
            spec, train_jsonl, teacher, student, output
        )
        _emit(payload)
        return 0
    except WorkerError as e:
        _emit({
            "ok": False,
            "error": e.code,
            "detail": str(e),
            "airgap_worker_version": AIRGAP_WORKER_VERSION,
        })
        return 2
    except Exception as e:  # noqa: BLE001 - worker boundary must emit JSON.
        _emit({
            "ok": False,
            "error": "airgap_worker_unhandled_error",
            "detail": str(e),
            "airgap_worker_version": AIRGAP_WORKER_VERSION,
        })
        return 1


if __name__ == "__main__":
    sys.exit(main())
