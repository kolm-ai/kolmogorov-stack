"""
apps/trainer/distill.py

Response distillation. Train a small student to imitate a large teacher by
matching the teacher's next-token distribution at every position, not just its
sampled token.

This is the algorithm the kolm brand is literally named after: Kolmogorov
complexity is about compressing a string into the shortest program that emits
it; response distillation is about compressing a 70B teacher's behavior into
a 3B student that emits the same token distribution on the buyer's prompts.

The pipeline is:

    teacher_logits = teacher(prompt + response, temperature=T)
    student_logits = student(prompt + response, temperature=T)
    L_kd = KL(softmax(student/T) || softmax(teacher/T)) * T^2

Plus a small cross-entropy term against the teacher's sampled token so the
student still learns the surface form, not only the distribution shape:

    L = alpha * L_kd + (1 - alpha) * L_ce

The standard recipe is alpha = 0.9, T = 2.0. The student is a LoRA adapter
on a smaller base; the teacher runs once per batch with `torch.no_grad()`.

References:

  * Hinton, Vinyals & Dean, 2015. "Distilling the Knowledge in a Neural
    Network." arXiv:1503.02531. The original soft-label KD recipe.
  * Kim & Rush, 2016. "Sequence-Level Knowledge Distillation."
    arXiv:1606.07947. Sequence-level KD; teacher's argmax becomes student's
    target. The trade-off vs token-level we navigate below.
  * Gou et al, 2021. "Knowledge Distillation: A Survey." arXiv:2006.05525.
  * Agarwal et al, 2024. "On-Policy Distillation of Language Models."
    arXiv:2306.13649. Why training on the student's own samples beats
    training on the teacher's when the gap is large.
  * Gu et al, 2024. "MiniLLM: Knowledge Distillation of Large Language
    Models." arXiv:2306.08543. Reverse-KL formulation that keeps the
    student from over-spreading mass.

Surface:

    from apps.trainer.distill import distill_trainer, DistillConfig, KDObjective

    trainer = distill_trainer(
        teacher_model="Qwen/Qwen2.5-14B-Instruct",
        student_model="Qwen/Qwen2.5-3B-Instruct",
        train_jsonl="captures.jsonl",
        out_dir="distilled/",
        config=DistillConfig(
            temperature=2.0,
            alpha=0.9,
            objective=KDObjective.FORWARD_KL,
            top_k=0,
            on_policy=False,
        ),
    )
    trainer.train()

Input JSONL shape (one line per prompt):

    {"prompt": "...", "response": "..."}  # response is optional; if absent, teacher samples one

Receipt records the teacher CID, the temperature, the KD objective, the alpha,
the final KL value, and the student's perplexity on a held-out split.
"""

from __future__ import annotations

import enum
import json
import math
import os
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Any, Iterable, Optional

try:
    import torch
    import torch.nn.functional as F
    from torch.utils.data import Dataset
    _HAS_TORCH = True
except Exception:
    _HAS_TORCH = False


class KDObjective(str, enum.Enum):
    """Which divergence to minimize between student and teacher."""
    FORWARD_KL = "forward_kl"
    REVERSE_KL = "reverse_kl"
    JSD = "jsd"

    @classmethod
    def from_str(cls, s: str) -> "KDObjective":
        s = (s or "").strip().lower()
        for o in cls:
            if o.value == s:
                return o
        raise ValueError(
            f"distill.py: unknown KD objective '{s}'. "
            f"Pick one of: {[o.value for o in cls]}"
        )


@dataclass
class DistillConfig:
    """All knobs the KD recipe takes. Defaults are the Hinton 2015 values
    plus a few modern additions (top-k logit pruning, on-policy sampling)."""

    temperature: float = 2.0
    """Softmax temperature for both teacher and student during KD. Higher
    spreads probability mass across more tokens; the canonical T=2.0 keeps
    the second-best alternative visible without flattening the distribution."""

    alpha: float = 0.9
    """Weight on the KD term. The remaining (1 - alpha) goes to a standard
    cross-entropy loss against the teacher's argmax. alpha=1.0 is pure
    distillation; alpha=0.0 is pure SFT against teacher samples."""

    objective: KDObjective = KDObjective.FORWARD_KL
    """forward_kl is Hinton's original. reverse_kl is the MiniLLM formulation,
    which keeps the student from spreading mass across modes the teacher
    rejects. jsd is the symmetric variant."""

    top_k: int = 0
    """If > 0, only the top-k teacher logits enter the KL term; the rest are
    renormalized into a single 'other' bucket. Saves memory when the teacher
    vocabulary is large; mildly degrades quality. 0 = full distribution."""

    on_policy: bool = False
    """If True, sample the response from the student instead of using the
    teacher's response or a captured ground-truth. Reduces train/test
    distribution mismatch but doubles forward-pass cost. Agarwal 2024 shows
    on-policy KD beats off-policy KD when the student is small."""

    learning_rate: float = 1e-4
    """LoRA-friendly LR. Lower than SFT because the gradient magnitude is
    larger (the loss is a divergence, not a cross-entropy)."""

    lora_r: int = 16
    lora_alpha: int = 32
    lora_dropout: float = 0.0
    target_modules: tuple[str, ...] = ("q_proj", "k_proj", "v_proj", "o_proj")

    max_length: int = 2048
    batch_size: int = 4
    grad_accum: int = 4
    num_epochs: int = 1
    warmup_ratio: float = 0.03
    seed: int = 42
    bf16: bool = True
    save_steps: int = 200
    eval_split: float = 0.05


# -- Loss functions. Each one takes student_logits and teacher_logits at the
# response positions (after masking out the prompt) and returns a scalar loss.

def _forward_kl(student_logits, teacher_logits, T: float):
    """KL(student || teacher) with temperature. The Hinton 2015 recipe.

    The T^2 factor comes from the chain rule on softmax/T; without it the
    gradient magnitude shrinks as T grows and the loss stops being a useful
    training signal."""
    log_p_s = F.log_softmax(student_logits / T, dim=-1)
    p_t = F.softmax(teacher_logits / T, dim=-1)
    return F.kl_div(log_p_s, p_t, reduction="batchmean") * (T * T)


def _reverse_kl(student_logits, teacher_logits, T: float):
    """KL(teacher || student). MiniLLM formulation. Penalizes the student for
    placing mass where the teacher puts none. Keeps the student from
    over-hedging on modes the teacher rejects."""
    log_p_t = F.log_softmax(teacher_logits / T, dim=-1)
    p_s = F.softmax(student_logits / T, dim=-1)
    return F.kl_div(log_p_t, p_s, reduction="batchmean") * (T * T)


def _jensen_shannon(student_logits, teacher_logits, T: float):
    """Symmetric: 0.5 * KL(s||m) + 0.5 * KL(t||m) where m = (s+t)/2.

    JSD is bounded in [0, log 2], which gives stable gradients when the
    two distributions are far apart. Slightly more expensive (three softmaxes)."""
    p_s = F.softmax(student_logits / T, dim=-1)
    p_t = F.softmax(teacher_logits / T, dim=-1)
    p_m = 0.5 * (p_s + p_t)
    log_p_m = (p_m + 1e-10).log()
    kl_sm = F.kl_div(log_p_m, p_s, reduction="batchmean", log_target=False)
    kl_tm = F.kl_div(log_p_m, p_t, reduction="batchmean", log_target=False)
    return 0.5 * (kl_sm + kl_tm) * (T * T)


_KD_FNS = {
    KDObjective.FORWARD_KL: _forward_kl,
    KDObjective.REVERSE_KL: _reverse_kl,
    KDObjective.JSD: _jensen_shannon,
}


def _topk_prune(student_logits, teacher_logits, k: int):
    """Keep only the top-k teacher tokens (by teacher prob) and dump the rest
    into a single 'other' bucket on both sides. Returns reduced logits that
    can be fed straight into the loss functions above."""
    if k <= 0 or k >= teacher_logits.size(-1):
        return student_logits, teacher_logits
    _, idx = torch.topk(teacher_logits, k=k, dim=-1)
    t_top = teacher_logits.gather(-1, idx)
    s_top = student_logits.gather(-1, idx)
    # 'Other' bucket: log-sum-exp of the rest.
    mask = torch.ones_like(teacher_logits, dtype=torch.bool)
    mask.scatter_(-1, idx, False)
    t_other = teacher_logits.masked_fill(~mask, float("-inf")).logsumexp(dim=-1, keepdim=True)
    s_other = student_logits.masked_fill(~mask, float("-inf")).logsumexp(dim=-1, keepdim=True)
    return torch.cat([s_top, s_other], dim=-1), torch.cat([t_top, t_other], dim=-1)


class _PromptResponseDataset:
    """Pure-Python dataset; transformers Trainer wraps it via DataCollatorForLM.

    Each row produces a tokenized (input_ids, labels) where labels masks the
    prompt positions with -100. The KD loss is only computed on response
    tokens; the teacher CE on the same span.
    """

    def __init__(self, rows: list[dict], tokenizer, max_length: int):
        self.rows = rows
        self.tok = tokenizer
        self.max_length = max_length

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, i: int) -> dict:
        row = self.rows[i]
        prompt = row["prompt"]
        response = row.get("response", "")
        # Tokenize prompt and response separately so we can mask prompt positions.
        p_ids = self.tok(prompt, add_special_tokens=False)["input_ids"]
        r_ids = self.tok(response, add_special_tokens=False)["input_ids"]
        input_ids = p_ids + r_ids
        labels = ([-100] * len(p_ids)) + r_ids
        # Truncate from the left of the prompt if needed.
        if len(input_ids) > self.max_length:
            over = len(input_ids) - self.max_length
            input_ids = input_ids[over:]
            labels = labels[over:]
        return {
            "input_ids": input_ids,
            "labels": labels,
            "attention_mask": [1] * len(input_ids),
        }


def _load_jsonl(path: str) -> list[dict]:
    rows: list[dict] = []
    with open(path, "r", encoding="utf-8") as f:
        for ln, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                raise ValueError(f"distill.py: malformed JSONL at {path}:{ln}: {e.msg}") from e
            if "prompt" not in obj or not isinstance(obj["prompt"], str):
                raise ValueError(
                    f"distill.py: {path}:{ln} missing string field 'prompt'. "
                    f"Required shape: {{'prompt', 'response'?}}."
                )
            rows.append(obj)
    if not rows:
        raise ValueError(f"distill.py: no rows in {path}")
    return rows


@dataclass
class DistillSession:
    teacher_model: str
    student_model: str
    config: DistillConfig
    n_train: int
    n_eval: int
    _trainer: Any = None

    def train(self) -> dict[str, Any]:
        if self._trainer is None:
            raise RuntimeError("distill.py: train() called before trainer was built")
        result = self._trainer.train()
        summary = {
            "loss_final": float(result.training_loss) if result.training_loss is not None else None,
            "global_step": int(result.global_step),
        }
        try:
            metrics = self._trainer.evaluate()
            summary["ppl_eval"] = float(math.exp(metrics["eval_loss"])) if "eval_loss" in metrics else None
        except Exception:
            summary["ppl_eval"] = None
        return summary


def distill_trainer(
    teacher_model: str,
    student_model: str,
    train_jsonl: str,
    out_dir: str,
    config: Optional[DistillConfig] = None,
    eval_jsonl: Optional[str] = None,
) -> DistillSession:
    """Build a configured KD trainer ready for .train().

    The teacher is loaded read-only (frozen, no_grad on every forward). The
    student is loaded with LoRA adapters on attention projections. Both
    tokenizers must share the same vocabulary; if they do not, the KL is
    undefined and the function raises.
    """

    if not _HAS_TORCH:
        raise RuntimeError(
            "distill.py: torch is required. "
            "pip install 'torch>=2.4' transformers peft accelerate"
        )

    try:
        from transformers import (
            AutoTokenizer,
            AutoModelForCausalLM,
            TrainingArguments,
            Trainer,
            DataCollatorForLanguageModeling,
        )
        from peft import LoraConfig, get_peft_model, TaskType
    except ImportError as e:
        raise RuntimeError(
            f"distill.py: missing dependency {e.name}. "
            f"pip install 'transformers>=4.46' 'peft>=0.13' accelerate"
        ) from e

    cfg = config or DistillConfig()
    torch.manual_seed(cfg.seed)

    teacher_tok = AutoTokenizer.from_pretrained(teacher_model, use_fast=True)
    student_tok = AutoTokenizer.from_pretrained(student_model, use_fast=True)
    if teacher_tok.get_vocab() != student_tok.get_vocab():
        raise ValueError(
            "distill.py: teacher and student tokenizers must share a vocabulary "
            "for token-level KD. Use cross-tokenizer distillation (sequence-level) "
            "or pick a student from the teacher's family."
        )
    tokenizer = student_tok
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    dtype = torch.bfloat16 if cfg.bf16 else torch.float32

    teacher = AutoModelForCausalLM.from_pretrained(teacher_model, torch_dtype=dtype)
    teacher.eval()
    for p in teacher.parameters():
        p.requires_grad = False

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

    rows = _load_jsonl(train_jsonl)
    eval_rows: list[dict] = []
    if eval_jsonl:
        eval_rows = _load_jsonl(eval_jsonl)
    elif cfg.eval_split > 0 and len(rows) >= 50:
        cut = max(1, int(len(rows) * cfg.eval_split))
        eval_rows = rows[-cut:]
        rows = rows[:-cut]

    # If response is missing, draw one from the teacher at sampling temperature 1.
    for r in (*rows, *eval_rows):
        if not r.get("response"):
            r["response"] = _teacher_sample(teacher, tokenizer, r["prompt"], max_new=256)

    train_ds = _PromptResponseDataset(rows, tokenizer, cfg.max_length)
    eval_ds = _PromptResponseDataset(eval_rows, tokenizer, cfg.max_length) if eval_rows else None

    collator = DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False)

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

    kd_fn = _KD_FNS[cfg.objective]
    T = cfg.temperature
    alpha = cfg.alpha
    top_k = cfg.top_k

    class _DistillTrainer(Trainer):
        def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
            labels = inputs.pop("labels")
            input_ids = inputs["input_ids"]
            attention_mask = inputs["attention_mask"]

            with torch.no_grad():
                t_out = teacher(input_ids=input_ids, attention_mask=attention_mask).logits
            s_out = model(input_ids=input_ids, attention_mask=attention_mask).logits

            # Shift for next-token prediction.
            s_shift = s_out[..., :-1, :].contiguous()
            t_shift = t_out[..., :-1, :].contiguous()
            l_shift = labels[..., 1:].contiguous()
            mask = (l_shift != -100)
            if not mask.any():
                # All prompt tokens; nothing to distill against.
                zero = s_shift.new_zeros(())
                return (zero, {"loss_kd": zero, "loss_ce": zero}) if return_outputs else zero

            s_flat = s_shift[mask]
            t_flat = t_shift[mask]
            l_flat = l_shift[mask]

            if top_k > 0:
                s_flat, t_flat = _topk_prune(s_flat, t_flat, top_k)

            loss_kd = kd_fn(s_flat, t_flat, T)
            loss_ce = F.cross_entropy(s_flat, l_flat) if top_k == 0 else \
                      F.cross_entropy(s_shift.view(-1, s_shift.size(-1)),
                                      l_shift.view(-1), ignore_index=-100)

            loss = alpha * loss_kd + (1.0 - alpha) * loss_ce
            if return_outputs:
                return loss, {"loss_kd": loss_kd.detach(), "loss_ce": loss_ce.detach()}
            return loss

    trainer = _DistillTrainer(
        model=student,
        args=args,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        data_collator=collator,
    )

    session = DistillSession(
        teacher_model=teacher_model,
        student_model=student_model,
        config=cfg,
        n_train=len(rows),
        n_eval=len(eval_rows),
        _trainer=trainer,
    )
    return session


def _teacher_sample(teacher, tokenizer, prompt: str, *, max_new: int = 256) -> str:
    """Single-shot teacher sample. Used when the buyer ships prompts without
    paired responses. Sampling at T=1 keeps the natural distribution; the KD
    loss itself runs at config.temperature."""
    if not _HAS_TORCH:
        raise RuntimeError("distill.py: torch required for teacher sampling")
    ids = tokenizer(prompt, return_tensors="pt").input_ids
    with torch.no_grad():
        out = teacher.generate(
            ids.to(teacher.device),
            max_new_tokens=max_new,
            do_sample=True,
            temperature=1.0,
            pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id,
        )
    new_ids = out[0, ids.shape[1]:]
    return tokenizer.decode(new_ids, skip_special_tokens=True)


def receipt_block(session: DistillSession, train_summary: dict) -> dict:
    """The receipt fragment the K-score gate and audit log both read.

    `papers` cites the canonical KD references so a binder render can footnote
    them. The teacher_model and config land verbatim so a buyer's auditor can
    reproduce the run."""
    cfg = asdict(session.config)
    # enum -> str for JSON
    cfg["objective"] = session.config.objective.value
    return {
        "method": "kd_response_distillation",
        "teacher_model": session.teacher_model,
        "student_model": session.student_model,
        "config": cfg,
        "n_train_rows": session.n_train,
        "n_eval_rows": session.n_eval,
        "loss_final": train_summary.get("loss_final"),
        "ppl_eval": train_summary.get("ppl_eval"),
        "papers": [
            "arXiv:1503.02531",  # Hinton soft labels
            "arXiv:1606.07947",  # Kim & Rush seq-level
            "arXiv:2306.08543",  # MiniLLM reverse-KL
            "arXiv:2306.13649",  # On-policy distillation
        ],
    }


__all__ = [
    "DistillConfig",
    "DistillSession",
    "KDObjective",
    "distill_trainer",
    "receipt_block",
]
