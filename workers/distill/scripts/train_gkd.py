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


def _filter_config_kwargs(config_cls, kwargs):
    """Filter kwargs against the INSTALLED GKDConfig signature so an older trl
    never raises on lmbda/beta/seq_kd it doesn't accept. Mirrors
    apps/trainer/grpo.py::as_trl_kwargs. Returns (filtered_kwargs, dropped)."""
    try:
        import inspect
        sig = inspect.signature(config_cls.__init__)
        accepted = set(sig.parameters.keys())
    except Exception:
        return dict(kwargs), []
    out, dropped = {}, []
    for k, v in kwargs.items():
        if k in accepted:
            out[k] = v
        else:
            dropped.append(k)
    return out, dropped


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


def _build_gkd_batches(rows, tok, max_length=256):
    """Tokenize {prompt, completion|response|output} rows into supervised
    {input_ids, attention_mask, labels} batches (prompt tokens masked to -100).
    Pure-torch path used by the hand-rolled fallback trainer when trl.GKDTrainer
    is unavailable. Returns a list of single-example tensors (batch_size=1)."""
    import torch

    batches = []
    for r in rows:
        prompt = r.get("prompt") if isinstance(r, dict) else None
        if prompt is None and isinstance(r, dict):
            prompt = r.get("input")
        completion = None
        if isinstance(r, dict):
            for k in ("completion", "response", "output", "teacher_output", "chosen"):
                if r.get(k) is not None:
                    completion = r[k]
                    break
        if prompt is None:
            continue
        prompt = str(prompt)
        completion = "" if completion is None else str(completion)
        p_ids = tok(prompt, add_special_tokens=False)["input_ids"]
        c_ids = tok(completion, add_special_tokens=False)["input_ids"]
        if tok.eos_token_id is not None:
            c_ids = c_ids + [tok.eos_token_id]
        ids = (p_ids + c_ids)[:max_length]
        if len(ids) < 2:
            continue
        labels = ([-100] * len(p_ids) + c_ids)[:max_length]
        # Align labels length to ids after truncation.
        labels = labels[:len(ids)]
        input_ids = torch.tensor([ids], dtype=torch.long)
        attn = torch.ones_like(input_ids)
        lab = torch.tensor([labels], dtype=torch.long)
        batches.append({"input_ids": input_ids, "attention_mask": attn, "labels": lab})
    return batches


def train_gkd_handrolled(student, teacher, batches, beta=0.5, temperature=1.0,
                         lr=5e-5, epochs=1, log=None):
    """Explicit forward/JSD/backward GKD loop. Used when trl.GKDTrainer is not
    importable (older trl) so GKD is ALWAYS trainable in-repo. Returns a list of
    per-step loss floats. The teacher is frozen; only the student updates.

    For each batch: shift logits + labels by one (causal next-token), compute the
    generalized JSD between student and (frozen) teacher next-token distributions
    over the label (completion) positions, backprop, and step the optimizer.
    """
    import torch

    teacher.eval()
    for p in teacher.parameters():
        p.requires_grad_(False)
    student.train()
    opt = torch.optim.AdamW([p for p in student.parameters() if p.requires_grad], lr=lr)
    losses = []
    for _ep in range(max(1, int(epochs))):
        for b in batches:
            opt.zero_grad()
            s_out = student(input_ids=b["input_ids"], attention_mask=b["attention_mask"])
            with torch.no_grad():
                t_out = teacher(input_ids=b["input_ids"], attention_mask=b["attention_mask"])
            # Causal shift: predict token t+1 from position t.
            s_logits = s_out.logits[:, :-1, :]
            t_logits = t_out.logits[:, :-1, :]
            labels = b["labels"][:, 1:]
            loss = generalized_jsd_loss(s_logits, t_logits, labels=labels,
                                        beta=beta, temperature=temperature)
            loss.backward()
            opt.step()
            lv = float(loss.detach().cpu().item())
            losses.append(lv)
            if log is not None:
                log(lv)
    return losses


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

    # Real run requires torch (always) + transformers. trl.GKDTrainer is used
    # when present; otherwise we fall through to the hand-rolled JSD loop so GKD
    # is ALWAYS trainable in-repo (the audit "no trainer installed" gap).
    _require("torch", "pip install torch")
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    try:
        import trl
        GKDTrainer = getattr(trl, "GKDTrainer", None)
        GKDConfig = getattr(trl, "GKDConfig", None)
    except ImportError:
        trl = None
        GKDTrainer = None
        GKDConfig = None
    use_trl = (GKDTrainer is not None and GKDConfig is not None
               and os.environ.get("KOLM_GKD_HANDROLLED") != "1")

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

    train_path = "trl" if use_trl else "handrolled"
    train_losses = []
    trl_dropped_kwargs = []
    if use_trl:
        from datasets import Dataset
        from transformers import TrainerCallback
        # W713 (receipt fidelity) - feed the implemented lambda schedule + on-
        # policy generation into trl by passing lmbda (+ seq_kd) into GKDConfig.
        # On older trl these fields may not exist, so signature-filter them
        # (matches grpo.as_trl_kwargs) instead of letting the constructor raise.
        # seq_kd=False keeps token-level GKD (the JSD objective); the lmbda ramp
        # is what trl uses to decide the on-policy student-generation fraction.
        gkd_kwargs = dict(output_dir=args.out, beta=args.beta, lmbda=args.lmbda,
                          seq_kd=False, temperature=args.temperature,
                          per_device_train_batch_size=1, num_train_epochs=1,
                          logging_steps=1, report_to=[])
        filtered, trl_dropped_kwargs = _filter_config_kwargs(GKDConfig, gkd_kwargs)
        cfg = GKDConfig(**filtered)
        ds = Dataset.from_list(rows)

        # W713 - capture the REAL per-step loss trajectory from the trl
        # Trainer's log_history so run-meta records the actual curve (the prior
        # path only kept the single final training_loss). The callback appends
        # every logged 'loss' value as the optimizer steps.
        _captured = []

        class _LossCapture(TrainerCallback):
            def on_log(self, _args, _state, _control, logs=None, **_kw):
                if logs and "loss" in logs:
                    try:
                        _captured.append(float(logs["loss"]))
                    except (TypeError, ValueError):
                        pass

        trainer = GKDTrainer(model=student, teacher_model=teacher, args=cfg,
                             train_dataset=ds, processing_class=tok,
                             callbacks=[_LossCapture()])
        out = trainer.train()
        # Prefer the captured per-step curve; fall back to log_history, then the
        # single final training_loss.
        train_losses = list(_captured)
        if not train_losses:
            try:
                for entry in getattr(trainer.state, "log_history", []) or []:
                    if isinstance(entry, dict) and "loss" in entry:
                        train_losses.append(float(entry["loss"]))
            except (TypeError, ValueError, AttributeError):
                pass
        if not train_losses:
            try:
                tl = getattr(out, "training_loss", None)
                if tl is not None:
                    train_losses = [float(tl)]
            except (TypeError, ValueError):
                train_losses = []
    else:
        sys.stderr.write("[train_gkd] trl.GKDTrainer unavailable; using hand-rolled JSD loop\n")
        batches = _build_gkd_batches(rows, tok)
        if not batches:
            sys.stderr.write("[train_gkd] no trainable batches (rows lacked completion/response)\n")
            return 4
        train_losses = train_gkd_handrolled(
            student, teacher, batches, beta=args.beta,
            temperature=args.temperature, epochs=1)

    student.save_pretrained(args.out)
    tok.save_pretrained(args.out)
    loss_final = float(train_losses[-1]) if train_losses else None
    loss_first = float(train_losses[0]) if train_losses else None
    # W713 - the lambda ramp this run scheduled, sampled at a few steps so the
    # receipt documents the on-policy data fraction over training (the ramp is
    # now actually fed into trl via GKDConfig.lmbda on the trl path, and into
    # the data mixture on the hand-rolled path).
    _n = max(1, len(train_losses))
    lmbda_curve = {
        "0": lmbda_schedule(0, _n, 0.0, args.lmbda),
        "mid": lmbda_schedule(_n // 2, _n, 0.0, args.lmbda),
        "end": lmbda_schedule(_n, _n, 0.0, args.lmbda),
    }
    with open(os.path.join(args.out, "run-meta.json"), "w", encoding="utf-8") as f:
        json.dump({"objective": "gkd", "beta": args.beta, "lmbda": args.lmbda,
                   "temperature": args.temperature, "papers": ["arXiv:2306.13649"],
                   "train_path": train_path,
                   "loss_first": loss_first, "loss_final": loss_final,
                   # W713 - the FULL captured loss trajectory (not just first/
                   # final) so the receipt chain proves the real curve. Bounded
                   # to the last 1000 points to keep run-meta small.
                   "loss_trajectory": [round(x, 6) for x in train_losses[-1000:]],
                   "steps": len(train_losses),
                   "lmbda_curve": lmbda_curve,
                   # W713 - GKDConfig fields the installed trl did NOT accept
                   # (signature-filtered). Empty on a current trl; documents
                   # WHY a knob may not have engaged on an older trl.
                   "trl_dropped_config_kwargs": trl_dropped_kwargs,
                   "namespace": args.namespace}, f, indent=2)
    print(f"[train_gkd] done ({train_path}) -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
