"""
apps/trainer/qad.py

Quantization-Aware Distillation (QAD) — the fusion of kolm's two core verbs
(distill + quantize) into one training pass.

Where the base distillation (apps/trainer/distill.py) trains a full-precision
student to match a teacher and then quantizes the result post-hoc (PTQ), QAD
trains the student with SIMULATED 4-bit weights in the forward pass. The
student therefore learns weights that are robust to 4-bit rounding *while it is
still learning*, instead of being snapped to the grid after the fact and hoping
accuracy survives. This is the difference between "we quantize your model" and
"we distill your model INTO the quantized format."

Frontier basis (web-verified, late May 2026):

  * NVIDIA Nemotron "Quantization-Aware Distillation for NVFP4 Inference
    Accuracy Recovery" (arXiv:2601.20088, 2026-01-27): a frozen BF16 teacher
    distills into an NVFP4 student by minimizing KL between their output token
    distributions, recovering up to 99.4% of BF16 accuracy. The student's
    weights are fake-quantized during training; gradients flow full-precision.
  * Kimi K2.6 (2026-04-20) ships native INT4 via QAT — post-hoc PTQ is now
    table stakes, so kolm's INT4 path must match QAT/QAD quality.

How QAD reuses distill.py (READ-ONLY import; distill.py is never edited):

  * The KD loss functions (`_forward_kl`, `_reverse_kl`, `_jensen_shannon`,
    `_distillm2`, plus the `_KD_FNS` registry and `KDObjective`) are imported
    and called directly. The QAD loop computes student/teacher logits exactly
    as distill.py's `_DistillTrainer.compute_loss` does, then calls the same
    loss — the ONLY difference is the student's Linear weights are wrapped with
    `fake_quant` (QDQ + straight-through-estimator) so the forward sees 4-bit
    numerics.
  * `DistillConfig` and the JSONL loader (`_load_jsonl`) are reused so a QAD
    recipe takes the same hyperparameters as a plain distill recipe.

The QAD-specific knobs ride in `QADConfig`:

    quant_format   'nf4' | 'fp4'   (fp4 == the NVFP4 element grid)
    quant_block    block-wise absmax granularity (16 == NVFP4)
    clip_ste       clipped straight-through backward (QAT-stable)
    warmup_steps   train this many steps in full precision before turning on
                   fake-quant (the standard QAT warmup that stabilizes early
                   training; 0 = quantize from step 0)

Determinism: the core loss + the fake-quant op take all randomness as the
config seed; no wall-clock, no global RNG inside the loss path. `--preflight`
and `--dry-run` resolve and validate the entire plan WITHOUT a GPU, without
loading any model weights, and without importing torch's CUDA path — so CI and
a laptop can verify the wiring before the orchestrator spends a GPU.

Surface:

    from apps.trainer.qad import qad_trainer, QADConfig, qad_preflight

    plan = qad_preflight(
        teacher_model="Qwen/Qwen2.5-7B-Instruct",
        student_model="Qwen/Qwen2.5-1.5B-Instruct",
        train_jsonl="captures.jsonl",
        out_dir="qad-out/",
        qad=QADConfig(quant_format="nf4", quant_block=16),
    )
    # plan.ok is True with a fully-resolved, GPU-free description of the run.

    session = qad_trainer(...)   # builds the real trainer (needs torch+GPU)
    summary = session.train()

CLI:

    python -m apps.trainer.qad --preflight \
        --teacher-model Qwen/Qwen2.5-7B-Instruct \
        --student-model Qwen/Qwen2.5-1.5B-Instruct \
        --train-jsonl captures.jsonl --out-dir qad-out/ \
        --quant-format nf4 --quant-block 16
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Any, Optional

# --- READ-ONLY reuse of distill.py. We import its loss machinery + config +
# loader; we never edit it. If torch is absent these imports of the pure
# python pieces (KDObjective, DistillConfig, _load_jsonl, KD fn registry) still
# succeed because distill.py guards its torch import. The torch-dependent loss
# *functions* are only CALLED inside the GPU train loop, never at import.
_DISTILL_IMPORT_ERR: Optional[str] = None
try:
    from apps.trainer.distill import (  # type: ignore
        DistillConfig,
        KDObjective,
        _KD_FNS,
        _topk_prune,
        _load_jsonl,
        _PromptResponseDataset,
        receipt_block as _distill_receipt_block,
    )
    _HAS_DISTILL = True
except Exception as _e:  # pragma: no cover - exercised only on a broken tree
    _DISTILL_IMPORT_ERR = f"{type(_e).__name__}: {_e}"
    _HAS_DISTILL = False

# --- fake_quant lives in the worker package; import it by file path so qad.py
# does not require the worker to be on PYTHONPATH. Falls back to a None marker
# the preflight reports rather than crashing.
_FAKE_QUANT_IMPORT_ERR: Optional[str] = None
_FAKE_QUANT_PATH = (
    Path(__file__).resolve().parent.parent.parent
    / "workers" / "distill" / "scripts" / "fake_quant.py"
)
try:
    import importlib.util as _ilu
    if _FAKE_QUANT_PATH.exists():
        _spec = _ilu.spec_from_file_location("kolm_fake_quant", str(_FAKE_QUANT_PATH))
        _fake_quant_mod = _ilu.module_from_spec(_spec)  # type: ignore
        # Register in sys.modules BEFORE exec so @dataclass (with `from
        # __future__ import annotations`) can resolve the module namespace via
        # sys.modules.get(cls.__module__) — otherwise the dataclass decorator
        # raises 'NoneType has no attribute __dict__' on a from-path import.
        sys.modules["kolm_fake_quant"] = _fake_quant_mod
        _spec.loader.exec_module(_fake_quant_mod)  # type: ignore
        FakeQuantConfig = _fake_quant_mod.FakeQuantConfig
        QuantFormat = _fake_quant_mod.QuantFormat
        fake_quant = _fake_quant_mod.fake_quant
        nf4_levels = _fake_quant_mod.nf4_levels
        fp4_e2m1_values = _fake_quant_mod.fp4_e2m1_values
        _HAS_FAKE_QUANT = True
    else:
        _FAKE_QUANT_IMPORT_ERR = f"fake_quant.py not found at {_FAKE_QUANT_PATH}"
        _HAS_FAKE_QUANT = False
except Exception as _e:  # pragma: no cover
    _FAKE_QUANT_IMPORT_ERR = f"{type(_e).__name__}: {_e}"
    _HAS_FAKE_QUANT = False

try:
    import torch
    import torch.nn.functional as F
    _HAS_TORCH = True
except Exception:
    torch = None  # type: ignore
    F = None  # type: ignore
    _HAS_TORCH = False


QAD_VERSION = "w921-qad-v1"

VALID_QUANT_FORMATS = ("nf4", "fp4")


@dataclass
class QADConfig:
    """QAD-specific knobs layered on top of a base DistillConfig.

    The base DistillConfig (temperature, alpha, objective, lora_*, lr, etc.)
    governs the distillation; QADConfig governs the fake-quant numerics."""

    quant_format: str = "nf4"
    """'nf4' (NormalFloat4, QLoRA grid) or 'fp4' (E2M1, the NVFP4 element grid)."""

    quant_block: int = 16
    """Block-wise absmax granularity. 16 matches NVFP4's 16-element blocks."""

    clip_ste: bool = True
    """Clipped straight-through-estimator backward (zeros gradient on weights
    that saturated the quantizer range). The QAT-stable default."""

    warmup_steps: int = 0
    """Train this many optimizer steps in full precision before enabling
    fake-quant. The standard QAT warmup; 0 = fake-quant from step 0."""

    quantize_target_modules: tuple[str, ...] = ("q_proj", "k_proj", "v_proj", "o_proj",
                                                "gate_proj", "up_proj", "down_proj")
    """Substrings of Linear module names to fake-quantize. Defaults to the
    attention + MLP projections (the bulk of the weight + the matmuls the
    deployed 4-bit kernel actually accelerates). LoRA adapter Linears are never
    matched (their names contain 'lora') so the adapter stays high-precision,
    matching how the deployed kernel quantizes the base and keeps the adapter."""

    def validate(self) -> Optional[str]:
        """Return None if valid, else a human error string."""
        if self.quant_format not in VALID_QUANT_FORMATS:
            return (
                f"quant_format must be one of {VALID_QUANT_FORMATS}, "
                f"got {self.quant_format!r}"
            )
        if not isinstance(self.quant_block, int) or self.quant_block <= 0:
            return f"quant_block must be a positive int, got {self.quant_block!r}"
        if not isinstance(self.warmup_steps, int) or self.warmup_steps < 0:
            return f"warmup_steps must be a non-negative int, got {self.warmup_steps!r}"
        return None

    def to_fake_quant_config(self):
        """Build the worker's FakeQuantConfig from this QADConfig."""
        if not _HAS_FAKE_QUANT:
            raise RuntimeError(
                "qad.py: fake_quant module unavailable: "
                + (_FAKE_QUANT_IMPORT_ERR or "unknown")
            )
        return FakeQuantConfig(
            fmt=self.quant_format,
            block_size=self.quant_block,
            clip_ste=self.clip_ste,
        )


@dataclass
class QADPreflight:
    """The GPU-free resolved plan. `ok` is True only when every precondition a
    real run needs (deps importable, recipe valid, JSONL present + non-empty,
    out dir writable) is satisfied. Otherwise `blockers` lists what's missing.

    Crucially, preflight NEVER loads model weights or touches CUDA — it is the
    cheap gate CI and a laptop run before the orchestrator spends a GPU.
    """

    ok: bool
    teacher_model: Optional[str]
    student_model: Optional[str]
    train_jsonl: Optional[str]
    out_dir: Optional[str]
    objective: str
    quant_format: str
    quant_block: int
    clip_ste: bool
    warmup_steps: int
    n_train_rows: Optional[int]
    deps: dict
    blockers: list
    notes: list

    def to_dict(self) -> dict:
        return asdict(self)


def _dep_report() -> dict:
    """Which dependencies are importable, WITHOUT importing torch's CUDA path
    or any model. torch availability is reported but a missing GPU is NOT a
    preflight blocker (preflight is the GPU-free gate)."""
    report = {
        "distill_module": _HAS_DISTILL,
        "fake_quant_module": _HAS_FAKE_QUANT,
        "torch": _HAS_TORCH,
        "torch_version": getattr(torch, "__version__", None) if _HAS_TORCH else None,
    }
    # transformers / peft are needed only for the real run; we probe import-
    # ability without instantiating anything.
    for mod in ("transformers", "peft", "accelerate"):
        try:
            __import__(mod)
            report[mod] = True
        except Exception:
            report[mod] = False
    if _DISTILL_IMPORT_ERR:
        report["distill_import_error"] = _DISTILL_IMPORT_ERR
    if _FAKE_QUANT_IMPORT_ERR:
        report["fake_quant_import_error"] = _FAKE_QUANT_IMPORT_ERR
    return report


def qad_preflight(
    teacher_model: Optional[str],
    student_model: Optional[str],
    train_jsonl: Optional[str],
    out_dir: Optional[str],
    config: Optional["DistillConfig"] = None,
    qad: Optional[QADConfig] = None,
    require_rows: bool = True,
) -> QADPreflight:
    """Resolve + validate the full QAD plan with NO GPU and NO model load.

    Checks (in order, all non-fatal — they accumulate into `blockers`):
      1. required args present
      2. QADConfig valid (format/block/warmup)
      3. base objective is a known KDObjective
      4. fake_quant module importable (the QAD numerics)
      5. train JSONL exists, parses, and has >= 1 row (when require_rows)
      6. out_dir is creatable / writable

    Never raises for an expected validation failure; returns ok=False with the
    blocker list so a caller (CLI / orchestrator) can print and exit cleanly.
    """
    qad = qad or QADConfig()
    blockers: list[str] = []
    notes: list[str] = []
    deps = _dep_report()

    # 1. required args
    for label, val in (
        ("teacher_model", teacher_model),
        ("student_model", student_model),
        ("train_jsonl", train_jsonl),
        ("out_dir", out_dir),
    ):
        if not val:
            blockers.append(f"missing required arg: {label}")

    # 2. QADConfig valid
    qad_err = qad.validate()
    if qad_err:
        blockers.append(f"QADConfig invalid: {qad_err}")

    # 3. base objective known
    objective_value = "forward_kl"
    if config is not None:
        try:
            objective_value = config.objective.value
        except Exception:
            objective_value = str(getattr(config, "objective", "forward_kl"))
    if _HAS_DISTILL:
        try:
            KDObjective.from_str(objective_value)
        except Exception as e:
            blockers.append(f"unknown KD objective {objective_value!r}: {e}")
    else:
        blockers.append(
            "apps.trainer.distill not importable (QAD reuses its losses): "
            + (_DISTILL_IMPORT_ERR or "unknown")
        )

    # 4. fake_quant module
    if not _HAS_FAKE_QUANT:
        blockers.append(
            "fake_quant module not importable (the QAD numerics): "
            + (_FAKE_QUANT_IMPORT_ERR or "unknown")
        )
    else:
        # Confirm the grid is the size we expect — a cheap sanity probe that
        # the numerics module is the right version.
        try:
            nlv = len(nf4_levels())
            if nlv != 16:
                blockers.append(f"NF4 grid has {nlv} levels (expected 16)")
            fpv = len(fp4_e2m1_values())
            if fpv != 15:
                blockers.append(f"FP4 E2M1 grid has {fpv} values (expected 15)")
        except Exception as e:
            blockers.append(f"fake_quant grid probe failed: {e}")

    # 5. train JSONL exists + parses + non-empty
    n_rows: Optional[int] = None
    if train_jsonl:
        p = Path(train_jsonl)
        if not p.exists():
            blockers.append(f"train_jsonl not found: {train_jsonl}")
        elif _HAS_DISTILL:
            try:
                rows = _load_jsonl(str(p))
                n_rows = len(rows)
                if require_rows and n_rows < 1:
                    blockers.append(f"train_jsonl has no rows: {train_jsonl}")
            except Exception as e:
                blockers.append(f"train_jsonl parse failed: {e}")
        else:
            notes.append("skipped JSONL parse (distill loader unavailable)")

    # 6. out_dir creatable
    if out_dir:
        try:
            os.makedirs(out_dir, exist_ok=True)
            # touch-test write permission without leaving a file behind.
            probe = os.path.join(out_dir, ".qad_preflight_write_probe")
            with open(probe, "w", encoding="utf-8") as f:
                f.write("ok")
            os.remove(probe)
        except OSError as e:
            blockers.append(f"out_dir not writable: {out_dir}: {e}")

    # Informational notes about the resolved numerics.
    if not _HAS_TORCH:
        notes.append("torch not importable — preflight ran GPU-free; real run needs torch")
    elif not torch.cuda.is_available():
        notes.append("no CUDA device visible — preflight ok; real run needs a GPU")
    if qad.warmup_steps > 0:
        notes.append(
            f"fake-quant enabled after {qad.warmup_steps} full-precision warmup steps"
        )
    else:
        notes.append("fake-quant enabled from step 0 (no warmup)")

    return QADPreflight(
        ok=(len(blockers) == 0),
        teacher_model=teacher_model,
        student_model=student_model,
        train_jsonl=train_jsonl,
        out_dir=out_dir,
        objective=objective_value,
        quant_format=qad.quant_format,
        quant_block=qad.quant_block,
        clip_ste=qad.clip_ste,
        warmup_steps=qad.warmup_steps,
        n_train_rows=n_rows,
        deps=deps,
        blockers=blockers,
        notes=notes,
    )


# ---------------------------------------------------------------------------
# QAD loss step. This is a STANDALONE function (not a method) so it is unit-
# testable on CPU with tiny tensors, and so it reuses distill.py's loss fns
# verbatim. It mirrors distill.py's _DistillTrainer.compute_loss EXACTLY except
# the student logits come from a fake-quant-wrapped forward (handled by the
# caller wrapping the model, not here) — this function only combines the
# already-computed logits with the imported KD loss.
# ---------------------------------------------------------------------------

def qad_loss_step(student_logits, teacher_logits, labels, objective, T: float,
                  alpha: float, top_k: int = 0):
    """Compute the QAD distillation loss for one batch.

    This calls the SAME KD loss function distill.py registers in `_KD_FNS`, so
    the QAD objective is identical to the base distill objective — the only
    difference in QAD is that `student_logits` were produced by a model whose
    weights were fake-quantized in the forward pass.

    Args mirror distill.py's compute_loss internals:
      student_logits, teacher_logits: (B, T, V) logits over the full sequence.
      labels:    (B, T) with -100 on prompt/pad positions.
      objective: a KDObjective (or its string value).
      T:         KD temperature.
      alpha:     weight on the KD term; (1-alpha) on the teacher-CE term.
      top_k:     optional teacher-logit top-k pruning (reuses _topk_prune).

    Returns a dict {loss, loss_kd, loss_ce}. `loss` carries grad to the
    student. Deterministic given the inputs (no RNG).
    """
    if not _HAS_TORCH:
        raise RuntimeError("qad.py: qad_loss_step requires torch")
    if not _HAS_DISTILL:
        raise RuntimeError(
            "qad.py: apps.trainer.distill not importable: "
            + (_DISTILL_IMPORT_ERR or "unknown")
        )
    if not isinstance(objective, KDObjective):
        objective = KDObjective.from_str(str(objective))
    kd_fn = _KD_FNS[objective]

    # Shift for next-token prediction (identical to distill.py).
    s_shift = student_logits[..., :-1, :].contiguous()
    t_shift = teacher_logits[..., :-1, :].contiguous()
    l_shift = labels[..., 1:].contiguous()
    mask = (l_shift != -100)
    if not mask.any():
        zero = s_shift.new_zeros(())
        return {"loss": zero, "loss_kd": zero, "loss_ce": zero}

    s_flat = s_shift[mask]
    t_flat = t_shift[mask]
    l_flat = l_shift[mask]

    if top_k > 0:
        s_flat, t_flat = _topk_prune(s_flat, t_flat, top_k)

    loss_kd = kd_fn(s_flat, t_flat, T)
    loss_ce = (
        F.cross_entropy(s_flat, l_flat) if top_k == 0
        else F.cross_entropy(
            s_shift.view(-1, s_shift.size(-1)), l_shift.view(-1), ignore_index=-100
        )
    )
    loss = alpha * loss_kd + (1.0 - alpha) * loss_ce
    return {"loss": loss, "loss_kd": loss_kd, "loss_ce": loss_ce}


@dataclass
class QADSession:
    """Holds the assembled QAD trainer + provenance. `.train()` runs the loop.

    The trainer is an HF Trainer subclass whose student model has had its
    target Linear layers wrapped with FakeQuantLinear, and whose compute_loss
    is the QAD step above. The teacher is frozen BF16, pinned to the device,
    invoked under no_grad — exactly as distill.py does it."""

    teacher_model: str
    student_model: str
    config: "DistillConfig"
    qad: QADConfig
    n_train: int
    n_eval: int
    wrapped_modules: dict
    out_dir: Optional[str] = None
    _trainer: Any = None

    def train(self) -> dict[str, Any]:
        if self._trainer is None:
            raise RuntimeError("qad.py: train() called before trainer was built")
        result = self._trainer.train()
        summary = {
            "loss_final": float(result.training_loss) if result.training_loss is not None else None,
            "global_step": int(result.global_step),
            "quant_format": self.qad.quant_format,
            "quant_block": self.qad.quant_block,
            "n_quantized_modules": len(self.wrapped_modules),
        }
        try:
            metrics = self._trainer.evaluate()
            summary["ppl_eval"] = (
                float(math.exp(metrics["eval_loss"])) if "eval_loss" in metrics else None
            )
        except Exception:
            summary["ppl_eval"] = None
        return summary


def _write_qad_run_meta(out_dir: Optional[str], meta: dict) -> Optional[str]:
    """Best-effort sibling run-meta.qad.json (mirrors distill.py's pattern)."""
    if not out_dir:
        return None
    try:
        os.makedirs(out_dir, exist_ok=True)
        p = os.path.join(out_dir, "run-meta.qad.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2, sort_keys=True)
        return p
    except OSError as e:
        print(f"qad.py: could not write run-meta.qad.json: {e}", file=sys.stderr)
        return None


def qad_trainer(
    teacher_model: str,
    student_model: str,
    train_jsonl: str,
    out_dir: str,
    config: Optional["DistillConfig"] = None,
    qad: Optional[QADConfig] = None,
    eval_jsonl: Optional[str] = None,
) -> QADSession:
    """Build a configured QAD trainer ready for .train().

    Reuses distill.py's loaders + losses + dataset (read-only import). The only
    QAD-specific behaviors are:
      1. wrap the student's target Linear layers with FakeQuantLinear so the
         forward uses 4-bit numerics (STE backward keeps gradients flowing);
      2. compute the loss via qad_loss_step (which calls distill.py's KD fn);
      3. optionally warm up `warmup_steps` in full precision before enabling
         fake-quant.

    Needs torch + transformers + peft + a GPU. Use qad_preflight() first for a
    GPU-free validation of the plan.
    """
    if not _HAS_TORCH:
        raise RuntimeError(
            "qad.py: torch is required. pip install 'torch>=2.2' transformers peft accelerate"
        )
    if not _HAS_DISTILL:
        raise RuntimeError(
            "qad.py: apps.trainer.distill not importable: " + (_DISTILL_IMPORT_ERR or "unknown")
        )
    if not _HAS_FAKE_QUANT:
        raise RuntimeError(
            "qad.py: fake_quant module not importable: " + (_FAKE_QUANT_IMPORT_ERR or "unknown")
        )

    try:
        from transformers import (
            AutoTokenizer, AutoModelForCausalLM, TrainingArguments, Trainer,
            DataCollatorForSeq2Seq,
        )
        from peft import LoraConfig, get_peft_model, TaskType
    except ImportError as e:
        raise RuntimeError(
            f"qad.py: missing dependency {e.name}. "
            f"pip install 'transformers>=4.46' 'peft>=0.13' accelerate"
        ) from e

    cfg = config or DistillConfig()
    qcfg = qad or QADConfig()
    qad_err = qcfg.validate()
    if qad_err:
        raise ValueError(f"qad.py: {qad_err}")

    torch.manual_seed(cfg.seed)

    teacher_tok = AutoTokenizer.from_pretrained(teacher_model, use_fast=True)
    student_tok = AutoTokenizer.from_pretrained(student_model, use_fast=True)
    if teacher_tok.get_vocab() != student_tok.get_vocab():
        raise ValueError(
            "qad.py: teacher and student tokenizers must share a vocabulary for "
            "token-level QAD. Pick a student from the teacher's family."
        )
    tokenizer = student_tok
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    dtype = torch.bfloat16 if cfg.bf16 else torch.float32

    teacher = AutoModelForCausalLM.from_pretrained(teacher_model, torch_dtype=dtype)
    teacher.eval()
    for p in teacher.parameters():
        p.requires_grad = False
    _device = "cuda" if torch.cuda.is_available() else "cpu"
    teacher.to(_device)

    student_base = AutoModelForCausalLM.from_pretrained(student_model, torch_dtype=dtype)
    lora_cfg = LoraConfig(
        task_type=TaskType.CAUSAL_LM,
        r=cfg.lora_r,
        lora_alpha=cfg.lora_alpha,
        lora_dropout=cfg.lora_dropout,
        target_modules=list(cfg.target_modules),
    )
    student = get_peft_model(student_base, lora_cfg)
    student.config.pad_token_id = tokenizer.pad_token_id

    # --- THE QAD STEP: wrap the student's target Linear layers with fake-quant.
    # We select Linears whose name contains a quantize_target_modules substring
    # AND does not contain 'lora' (handled by the worker's default name_filter).
    fq_config = qcfg.to_fake_quant_config()
    targets = tuple(qcfg.quantize_target_modules)

    def _name_filter(qn: str) -> bool:
        low = qn.lower()
        if "lora" in low:
            return False
        return any(t in low for t in targets)

    wrapped = _fake_quant_mod.wrap_linear_modules(student, fq_config, name_filter=_name_filter)
    if not wrapped:
        # No layer matched — refuse to silently run a "QAD" job that quantizes
        # nothing (that would just be plain distillation mislabeled).
        raise ValueError(
            "qad.py: quantize_target_modules matched 0 Linear layers in the "
            f"student. targets={targets}. Adjust the recipe's "
            "quantize_target_modules to the student's actual projection names."
        )

    rows = _load_jsonl(train_jsonl)
    eval_rows: list[dict] = []
    if eval_jsonl:
        eval_rows = _load_jsonl(eval_jsonl)
    elif cfg.eval_split > 0 and len(rows) >= 50:
        import random as _random
        _random.seed(cfg.seed)
        _random.shuffle(rows)
        cut = max(1, int(len(rows) * cfg.eval_split))
        rows, eval_rows = rows[:-cut], rows[-cut:]

    train_ds = _PromptResponseDataset(rows, tokenizer, cfg.max_length)
    eval_ds = _PromptResponseDataset(eval_rows, tokenizer, cfg.max_length) if eval_rows else None
    collator = DataCollatorForSeq2Seq(tokenizer=tokenizer, label_pad_token_id=-100, padding=True)

    args = TrainingArguments(
        output_dir=out_dir,
        num_train_epochs=cfg.num_epochs,
        per_device_train_batch_size=cfg.batch_size,
        per_device_eval_batch_size=cfg.batch_size,
        gradient_accumulation_steps=cfg.grad_accum,
        learning_rate=cfg.learning_rate,
        warmup_ratio=cfg.warmup_ratio,
        save_steps=cfg.save_steps,
        eval_strategy="steps" if eval_ds else "no",
        eval_steps=cfg.save_steps if eval_ds else None,
        logging_steps=20,
        bf16=cfg.bf16,
        seed=cfg.seed,
        report_to=[],
        remove_unused_columns=False,
    )

    T = cfg.temperature
    alpha = cfg.alpha
    top_k = cfg.top_k
    objective = cfg.objective
    warmup_steps = qcfg.warmup_steps
    fq_cfg = fq_config

    class _QADTrainer(Trainer):
        def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
            labels = inputs.pop("labels")
            input_ids = inputs["input_ids"]
            attention_mask = inputs["attention_mask"]

            # QAT warmup: for the first `warmup_steps` optimizer steps, run the
            # student in full precision (toggle every FakeQuantLinear off). The
            # state lives on the trainer; we read self.state.global_step.
            step = int(getattr(self.state, "global_step", 0))
            quant_on = step >= warmup_steps
            if not quant_on:
                # Temporarily bypass fake-quant by snapshotting + disabling.
                _toggle_fake_quant(model, enabled=False)

            with torch.no_grad():
                t_out = teacher(input_ids=input_ids, attention_mask=attention_mask).logits
            s_out = model(input_ids=input_ids, attention_mask=attention_mask).logits

            if not quant_on:
                _toggle_fake_quant(model, enabled=True)

            res = qad_loss_step(s_out, t_out, labels, objective, T, alpha, top_k)
            loss = res["loss"]
            if return_outputs:
                return loss, {
                    "loss_kd": res["loss_kd"].detach(),
                    "loss_ce": res["loss_ce"].detach(),
                    "quant_on": quant_on,
                }
            return loss

    trainer = _QADTrainer(
        model=student, args=args, train_dataset=train_ds, eval_dataset=eval_ds,
        data_collator=collator,
    )

    _write_qad_run_meta(out_dir, {
        "qad_version": QAD_VERSION,
        "quant_format": qcfg.quant_format,
        "quant_block": qcfg.quant_block,
        "clip_ste": qcfg.clip_ste,
        "warmup_steps": qcfg.warmup_steps,
        "objective": objective.value if hasattr(objective, "value") else str(objective),
        "n_quantized_modules": len(wrapped),
        "quantized_modules": sorted(wrapped.keys()),
        "n_train_rows": len(rows),
        "n_eval_rows": len(eval_rows),
        "seed": int(cfg.seed),
    })

    return QADSession(
        teacher_model=teacher_model,
        student_model=student_model,
        config=cfg,
        qad=qcfg,
        n_train=len(rows),
        n_eval=len(eval_rows),
        wrapped_modules=wrapped,
        out_dir=out_dir,
        _trainer=trainer,
    )


def _toggle_fake_quant(model, enabled: bool) -> None:
    """Flip every FakeQuantLinear under `model` between fake-quant (enabled) and
    full-precision passthrough (disabled). Used for the QAT warmup. We swap the
    block_size to a sentinel that the layer treats as 'do not quantize' by
    setting a per-layer flag rather than mutating the shared config.

    Implementation: each FakeQuantLinear gets a `_qad_bypass` attribute; the
    layer's forward checks it. We monkey-set it here. (The worker's
    FakeQuantLinear.forward respects `_qad_bypass` when present via getattr.)
    """
    if not _HAS_FAKE_QUANT:
        return
    FakeQuantLinear = getattr(_fake_quant_mod, "FakeQuantLinear", None)
    if FakeQuantLinear is None:
        return
    for m in model.modules():
        if isinstance(m, FakeQuantLinear):
            setattr(m, "_qad_bypass", (not enabled))


def receipt_block(session: QADSession, train_summary: dict) -> dict:
    """The receipt fragment the K-score gate + audit log read for a QAD run.

    Layers QAD-specific provenance on top of the base distill receipt shape so
    a verifier can confirm the artifact was trained quant-aware (not PTQ'd)."""
    objective = session.config.objective
    base = {
        "method": "qad_quant_aware_distillation",
        "teacher_model": session.teacher_model,
        "student_model": session.student_model,
        "seed": int(session.config.seed),
        "objective": objective.value if hasattr(objective, "value") else str(objective),
        "n_train_rows": session.n_train,
        "n_eval_rows": session.n_eval,
        "loss_final": train_summary.get("loss_final"),
        "ppl_eval": train_summary.get("ppl_eval"),
        "quant": {
            "format": session.qad.quant_format,
            "block_size": session.qad.quant_block,
            "clip_ste": session.qad.clip_ste,
            "warmup_steps": session.qad.warmup_steps,
            "n_quantized_modules": len(session.wrapped_modules),
        },
        "qad_version": QAD_VERSION,
        "papers": [
            "arXiv:2601.20088",  # NVIDIA Nemotron QAD for NVFP4
            "arXiv:2305.14314",  # QLoRA NF4
            "arXiv:1903.05662",  # Straight-through estimator
            "arXiv:1503.02531",  # Hinton soft-label KD (the base loss)
        ],
    }
    return base


__all__ = [
    "QAD_VERSION",
    "QADConfig",
    "QADPreflight",
    "QADSession",
    "qad_preflight",
    "qad_loss_step",
    "qad_trainer",
    "receipt_block",
]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="qad.py",
        description=(
            "Quantization-Aware Distillation: distill a student INTO a 4-bit "
            "(NF4/FP4-NVFP4) numerical format by fake-quantizing its weights "
            "during the distill loop (QDQ forward + straight-through backward)."
        ),
    )
    p.add_argument("--teacher-model", type=str, default=None)
    p.add_argument("--student-model", type=str, default=None)
    p.add_argument("--train-jsonl", type=str, default=None)
    p.add_argument("--eval-jsonl", type=str, default=None)
    p.add_argument("--out-dir", type=str, default=None)
    # base distill knobs (subset; the rest take DistillConfig defaults)
    p.add_argument("--objective", type=str, default="forward_kl")
    p.add_argument("--temperature", type=float, default=None)
    p.add_argument("--alpha", type=float, default=None)
    p.add_argument("--seed", type=int, default=None)
    p.add_argument("--num-epochs", type=int, default=None)
    p.add_argument("--batch-size", type=int, default=None)
    p.add_argument("--learning-rate", type=float, default=None)
    p.add_argument("--max-length", type=int, default=None)
    # QAD knobs
    p.add_argument("--quant-format", type=str, default="nf4", choices=list(VALID_QUANT_FORMATS),
                   help="nf4 (NormalFloat4) or fp4 (E2M1 / NVFP4 element grid).")
    p.add_argument("--quant-block", type=int, default=16,
                   help="Block-wise absmax granularity (16 matches NVFP4).")
    p.add_argument("--no-clip-ste", dest="clip_ste", action="store_false", default=True,
                   help="Disable clipped straight-through; use pure identity backward.")
    p.add_argument("--warmup-steps", type=int, default=0,
                   help="Full-precision warmup steps before enabling fake-quant.")
    # modes
    p.add_argument("--preflight", action="store_true",
                   help="Validate the full plan GPU-free (no model load) and exit.")
    p.add_argument("--dry-run", dest="preflight", action="store_true",
                   help="Alias for --preflight.")
    return p


def _config_from_args(args: argparse.Namespace) -> "DistillConfig":
    if not _HAS_DISTILL:
        # A minimal stand-in so --preflight can still report the objective
        # string when the distill module failed to import.
        class _Stub:
            pass
        s = _Stub()
        class _Obj:
            value = args.objective
        s.objective = _Obj()
        s.seed = args.seed if args.seed is not None else 42
        return s  # type: ignore
    kwargs: dict[str, Any] = {"objective": KDObjective.from_str(args.objective)}
    if args.temperature is not None:
        kwargs["temperature"] = args.temperature
    if args.alpha is not None:
        kwargs["alpha"] = args.alpha
    if args.seed is not None:
        kwargs["seed"] = args.seed
    if args.num_epochs is not None:
        kwargs["num_epochs"] = args.num_epochs
    if args.batch_size is not None:
        kwargs["batch_size"] = args.batch_size
    if args.learning_rate is not None:
        kwargs["learning_rate"] = args.learning_rate
    if args.max_length is not None:
        kwargs["max_length"] = args.max_length
    return DistillConfig(**kwargs)


def main(argv: Optional[list[str]] = None) -> int:
    args = _build_argparser().parse_args(argv)
    cfg = _config_from_args(args)
    qcfg = QADConfig(
        quant_format=args.quant_format,
        quant_block=args.quant_block,
        clip_ste=args.clip_ste,
        warmup_steps=args.warmup_steps,
    )

    if args.preflight:
        plan = qad_preflight(
            teacher_model=args.teacher_model,
            student_model=args.student_model,
            train_jsonl=args.train_jsonl,
            out_dir=args.out_dir,
            config=cfg if _HAS_DISTILL else None,
            qad=qcfg,
        )
        print(json.dumps(plan.to_dict(), indent=2, sort_keys=True))
        return 0 if plan.ok else 3

    # Real run path.
    missing = [k for k, v in (
        ("--teacher-model", args.teacher_model),
        ("--student-model", args.student_model),
        ("--train-jsonl", args.train_jsonl),
        ("--out-dir", args.out_dir),
    ) if not v]
    if missing:
        print(f"qad.py: missing required args: {', '.join(missing)}", file=sys.stderr)
        return 2

    session = qad_trainer(
        teacher_model=args.teacher_model,
        student_model=args.student_model,
        train_jsonl=args.train_jsonl,
        out_dir=args.out_dir,
        eval_jsonl=args.eval_jsonl,
        config=cfg,
        qad=qcfg,
    )
    summary = session.train()
    receipt = receipt_block(session, summary)
    print(json.dumps(receipt, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
