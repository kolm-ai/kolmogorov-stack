#!/usr/bin/env python3
# workers/distill/scripts/train_gkd.py
#
# W921 — On-policy distillation (GKD, Agarwal et al. arXiv:2306.13649). Train on
# student-GENERATED samples with teacher feedback, mixing teacher-data and
# student-data via a lambda schedule, using a generalized JSD loss. Wraps the
# trl.GKDTrainer when present; otherwise exposes the pure loss + schedule
# functions for unit testing + a --preflight path.
#
# CLI:
#   python train_gkd.py --prompts <jsonl> --student <path> --teacher <path|url>
#     --out <dir> --beta 0.5 --lmbda 0.5 [--preflight-only]
#
# The generalized JSD with interpolation beta:
#   JSD_beta(P||Q) = beta*KL(P||M) + (1-beta)*KL(Q||M),  M = beta*P + (1-beta)*Q
# beta=0.5 is symmetric JSD; beta->1 approaches forward KL, beta->0 reverse KL.

from __future__ import annotations

import argparse
import json
import math
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, _REPO)


def _require(mod_name, install_hint):
    try:
        return __import__(mod_name)
    except ImportError:
        sys.stderr.write(f"[train_gkd] missing dependency '{mod_name}'.\n")
        sys.stderr.write(f"            install hint: {install_hint}\n")
        sys.exit(3)


def generalized_jsd_loss(student_logits, teacher_logits, labels=None, beta=0.5,
                         temperature=1.0, reduction="batchmean"):
    """Generalized Jensen-Shannon divergence with interpolation `beta`.

    JSD_beta(P||Q) = beta*KL(P||M) + (1-beta)*KL(Q||M), M = beta*P+(1-beta)*Q,
    where P = teacher softmax, Q = student softmax (both at `temperature`).
    Masks out label==-100 positions when labels are given.
    """
    import torch
    import torch.nn.functional as F

    s = student_logits / temperature
    t = teacher_logits / temperature
    log_q = F.log_softmax(s, dim=-1)
    log_p = F.log_softmax(t, dim=-1)
    p = log_p.exp()
    q = log_q.exp()
    m = beta * p + (1.0 - beta) * q
    log_m = (m + 1e-12).log()
    # KL(P||M) = sum p*(log_p - log_m); KL(Q||M) = sum q*(log_q - log_m)
    kl_pm = (p * (log_p - log_m)).sum(dim=-1)
    kl_qm = (q * (log_q - log_m)).sum(dim=-1)
    per_tok = beta * kl_pm + (1.0 - beta) * kl_qm
    if labels is not None:
        mask = (labels != -100).float()
        per_tok = per_tok * mask
        denom = mask.sum().clamp_min(1.0)
        if reduction == "batchmean":
            return per_tok.sum() / denom
    if reduction == "batchmean":
        return per_tok.mean()
    if reduction == "sum":
        return per_tok.sum()
    return per_tok


def lmbda_schedule(step, total_steps, lmbda_start=0.0, lmbda_end=1.0, warmup_frac=0.1):
    """Fraction of ON-POLICY (student-generated) data at this step. Ramps from
    lmbda_start to lmbda_end after a warmup_frac fraction of training (so the
    student first learns from teacher data, then increasingly from its own
    rollouts). Returns a float in [lmbda_start, lmbda_end]."""
    if total_steps <= 0:
        return float(lmbda_end)
    warmup_steps = max(1, int(total_steps * warmup_frac))
    if step < warmup_steps:
        return float(lmbda_start)
    frac = (step - warmup_steps) / max(1, total_steps - warmup_steps)
    frac = min(1.0, max(0.0, frac))
    return float(lmbda_start + (lmbda_end - lmbda_start) * frac)


def generate_on_policy_outputs(model, prompts, attention_mask=None,
                               generation_config=None, pad_token_id=None):
    """Sample on-policy rollouts from the current student. Thin wrapper around
    model.generate that returns the generated token ids (for the lambda-mixture
    rollout in the GKD training step)."""
    import torch
    with torch.no_grad():
        kwargs = {}
        if attention_mask is not None:
            kwargs["attention_mask"] = attention_mask
        if generation_config is not None:
            kwargs["generation_config"] = generation_config
        if pad_token_id is not None:
            kwargs["pad_token_id"] = pad_token_id
        return model.generate(prompts, **kwargs)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="kolm on-policy distillation (GKD)")
    p.add_argument("--prompts", required=True)
    p.add_argument("--student", required=True)
    p.add_argument("--teacher", default=None, help="local teacher path/url (logits required)")
    p.add_argument("--out", required=True)
    p.add_argument("--beta", type=float, default=0.5, help="JSD interpolation")
    p.add_argument("--lmbda", type=float, default=0.5, help="on-policy data fraction (final)")
    p.add_argument("--temperature", type=float, default=1.0)
    p.add_argument("--namespace", default="default")
    p.add_argument("--preflight-only", action="store_true")
    args = p.parse_args(argv)

    if not 0.0 <= args.beta <= 1.0:
        sys.stderr.write("[train_gkd] beta must be in [0,1]\n")
        return 6
    if not args.teacher:
        sys.stderr.write("[train_gkd] GKD needs a LOCAL teacher (logits); pass --teacher\n")
        return 7

    if args.preflight_only:
        os.makedirs(args.out, exist_ok=True)
        meta = {
            "ok": True, "preflight": "ok", "objective": "gkd",
            "beta": args.beta, "lmbda_final": args.lmbda,
            "lmbda_at_steps": {
                "0": lmbda_schedule(0, 100, 0.0, args.lmbda),
                "50": lmbda_schedule(50, 100, 0.0, args.lmbda),
                "100": lmbda_schedule(100, 100, 0.0, args.lmbda),
            },
        }
        print(json.dumps(meta))
        return 0

    # Real run requires trl GKDTrainer + torch.
    _require("torch", "pip install torch")
    trl = _require("trl", "pip install 'trl>=0.12.0'")
    GKDTrainer = getattr(trl, "GKDTrainer", None)
    GKDConfig = getattr(trl, "GKDConfig", None)
    if GKDTrainer is None or GKDConfig is None:
        sys.stderr.write("[train_gkd] trl is too old for GKDTrainer; pip install -U 'trl>=0.12.0'\n")
        return 8

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from datasets import Dataset

    rows = []
    with open(args.prompts, "r", encoding="utf-8") as f:
        for ln in f:
            ln = ln.strip()
            if ln:
                try:
                    rows.append(json.loads(ln))
                except json.JSONDecodeError:
                    pass
    if not rows:
        sys.stderr.write("[train_gkd] no prompts loaded\n")
        return 4

    os.makedirs(args.out, exist_ok=True)
    tok = AutoTokenizer.from_pretrained(args.student)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
    student = AutoModelForCausalLM.from_pretrained(args.student, torch_dtype=dtype)
    teacher = AutoModelForCausalLM.from_pretrained(args.teacher, torch_dtype=dtype)

    cfg = GKDConfig(output_dir=args.out, beta=args.beta, lmbda=args.lmbda,
                    temperature=args.temperature, per_device_train_batch_size=1,
                    num_train_epochs=1, report_to=[])
    ds = Dataset.from_list(rows)
    trainer = GKDTrainer(model=student, teacher_model=teacher, args=cfg,
                         train_dataset=ds, processing_class=tok)
    trainer.train()
    student.save_pretrained(args.out)
    tok.save_pretrained(args.out)
    with open(os.path.join(args.out, "run-meta.json"), "w", encoding="utf-8") as f:
        json.dump({"objective": "gkd", "beta": args.beta, "lmbda": args.lmbda,
                   "temperature": args.temperature, "papers": ["arXiv:2306.13649"],
                   "namespace": args.namespace}, f, indent=2)
    print(f"[train_gkd] done -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
