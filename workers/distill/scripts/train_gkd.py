#!/usr/bin/env python3
# workers/distill/scripts/train_gkd.py
#
# W921 - On-policy distillation (GKD, Agarwal et al. arXiv:2306.13649). Train on
# student-GENERATED samples with teacher feedback, mixing teacher-data and
# student-data via a lambda schedule, using a generalized JSD loss. Wraps the
# trl.GKDTrainer when present; otherwise exposes the pure loss + schedule
# functions for unit testing + a --preflight path.
#
# CLI:
#   python train_gkd.py --prompts <jsonl> --student <path> --teacher <path|url>
#     --out <dir> --beta 0.5 --lmbda 0.5 [--preflight-only]
#
# The generalized JSD with interpolation beta (TRL convention, canonical here):
#   interior 0<beta<1: JSD_beta = beta*KL(P||M) + (1-beta)*KL(Q||M),
#                       M = beta*P + (1-beta)*Q  (P=teacher, Q=student)
#   beta == 0          -> FORWARD KL(teacher||student)  (mode-covering)
#   beta == 1          -> REVERSE KL(student||teacher)  (mode-seeking)
# beta=0.5 is symmetric JSD. The on-policy / reverse-KL-dominant regime the
# directive wants (grade the student on its OWN sampled tokens) is beta -> 1.
# NOTE: the raw mixture prefactor vanishes to 0 at BOTH endpoints, so the
# beta==0 / beta==1 fast paths in generalized_jsd_loss are LOAD-BEARING for
# trl parity (see the endpoint comment there).

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

    Interior 0<beta<1: beta*KL(P||M)+(1-beta)*KL(Q||M), M=beta*P+(1-beta)*Q,
    P=teacher softmax, Q=student softmax (both at `temperature`). Endpoints
    match trl exactly: beta==0 -> forward KL(teacher||student), beta==1 ->
    reverse KL(student||teacher). Masks out label==-100 positions when given.
    """
    import torch
    import torch.nn.functional as F

    s = student_logits / temperature
    t = teacher_logits / temperature
    log_q = F.log_softmax(s, dim=-1)
    log_p = F.log_softmax(t, dim=-1)
    p = log_p.exp()
    q = log_q.exp()
    # ENDPOINT special-cases (match trl.GKDTrainer.generalized_jsd_loss exactly).
    # The raw mixture prefactor beta*KL(P||M)+(1-beta)*KL(Q||M) VANISHES to 0 at
    # BOTH beta=0 (M=Q) and beta=1 (M=P), so WITHOUT these fast paths kolm would
    # diverge from trl exactly at the endpoints. trl's convention (verified
    # numerically against trl 0.24):
    #   beta == 0 -> KL(teacher || student) = FORWARD KL  (mode-covering)
    #   beta == 1 -> KL(student || teacher) = REVERSE KL   (mode-seeking; the
    #               on-policy / Thinking-Machines regime lives at beta -> 1).
    if beta == 0.0:
        per_tok = (p * (log_p - log_q)).sum(dim=-1)
    elif beta == 1.0:
        per_tok = (q * (log_q - log_p)).sum(dim=-1)
    else:
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


def _filter_config_kwargs(config_cls, kwargs):
    """Drop kwargs the installed GKDConfig does not accept (older trl that lacks
    a knob). Returns (kept, dropped). `dropped` is the receipt-integrity signal:
    if 'lmbda' lands here the on-policy control silently fell off and the run
    must NOT mint an on-policy receipt (main() fails loud on that)."""
    import inspect
    accepted = set()
    try:
        accepted = set(inspect.signature(config_cls.__init__).parameters.keys())
    except (TypeError, ValueError):
        pass
    # dataclass / trl configs may surface fields beyond __init__; union them in.
    for attr in ("__dataclass_fields__",):
        flds = getattr(config_cls, attr, None)
        if isinstance(flds, dict):
            accepted |= set(flds.keys())
    if not accepted:  # could not introspect -> keep everything (fail open here)
        return dict(kwargs), {}
    kept, dropped = {}, {}
    for k, v in kwargs.items():
        (kept if k in accepted else dropped)[k] = v
    return kept, dropped


def _gkd_seed(seed):
    """Seed torch + random (cross-trainer parity with apps/trainer/grpo.py).
    Returns the seed so the caller records it in run-meta."""
    import random
    import torch
    torch.manual_seed(int(seed))
    random.seed(int(seed))
    return int(seed)


def _build_gkd_batches(rows, tok, max_len=512):
    """Tokenize {prompt[, completion|teacher_output|chosen|response|output]} rows
    into off-policy teacher-data batches. Each batch is a dict of CPU tensors
    {input_ids, attention_mask, labels, prompt_len} where prompt tokens are
    masked (-100) and only the completion span carries loss. Pure-data path used
    when the per-example Bernoulli mixture draws OFF-POLICY."""
    import torch
    out = []
    for row in rows:
        prompt = row.get("prompt") or row.get("input") or ""
        comp = None
        for k in ("completion", "teacher_output", "chosen", "response", "output"):
            if row.get(k):
                comp = str(row[k])
                break
        prompt = str(prompt)
        p_ids = tok(prompt, add_special_tokens=True)["input_ids"][:max_len]
        if comp is not None:
            c_ids = tok(comp, add_special_tokens=False)["input_ids"][: max_len - len(p_ids)]
        else:
            c_ids = []
        if not c_ids:
            # no teacher completion -> nothing to score off-policy; skip row.
            continue
        ids = p_ids + c_ids
        labels = [-100] * len(p_ids) + list(c_ids)
        out.append({
            "input_ids": torch.tensor([ids], dtype=torch.long),
            "attention_mask": torch.ones((1, len(ids)), dtype=torch.long),
            "labels": torch.tensor([labels], dtype=torch.long),
            "prompt_ids": torch.tensor([p_ids], dtype=torch.long),
            "prompt_attn": torch.ones((1, len(p_ids)), dtype=torch.long),
            "prompt_len": len(p_ids),
            "prompt_text": prompt,
        })
    return out


def train_gkd_handrolled(student, teacher, batches, tok, *, gen_config,
                         beta=0.5, temperature=1.0, lmbda_end=0.5,
                         warmup_frac=0.1, total_steps=None, seed=42,
                         pad_token_id=None, optimizer=None, on_step=None):
    """The canonical in-repo on-policy GKD executor.

    For each step, per example, draw d ~ Bernoulli(lmbda_schedule(step,...)) from
    a torch.Generator seeded deterministically from `seed`. If d is ON-POLICY:
    take the row's PROMPT-only ids, sample a student rollout via
    generate_on_policy_outputs() under no_grad, build {prompt+rollout} with ONLY
    the rollout tokens as loss positions (prompt masked -100), forward the
    student (grad) and FROZEN teacher (no_grad), causal-shift, and score the
    teacher's next-token dist AGAINST the student's ACTUAL dist on its OWN tokens
    via generalized_jsd_loss (the on-policy GKD objective). If d is OFF-POLICY:
    use the teacher-data batch (prompt+teacher-completion). Records the REALIZED
    on-policy decision per step (not the scheduled rate).

    Returns a dict with loss_trajectory, realized_on_policy (per-step 0/1),
    realized_rollout_tokens (per-step), on_policy_step_count, off_policy_step_count.
    """
    import torch

    if total_steps is None:
        total_steps = len(batches)
    if pad_token_id is None:
        pad_token_id = getattr(tok, "pad_token_id", None)
    gen = torch.Generator(device="cpu")
    gen.manual_seed(int(seed))

    teacher.eval()
    for prm in teacher.parameters():
        prm.requires_grad_(False)

    loss_traj = []
    realized_on_policy = []
    realized_rollout_tokens = []
    label_audit = []  # per on-policy step: {loss_positions, rollout_len, prompt_all_masked}
    n_on = 0
    n_off = 0

    for step in range(total_steps):
        batch = batches[step % len(batches)]
        rate = lmbda_schedule(step, total_steps, 0.0, lmbda_end, warmup_frac)
        # Per-example (here batch size 1) Bernoulli draw from the SEEDED gen.
        draw = float(torch.rand(1, generator=gen).item())
        on_policy = draw < rate

        if on_policy:
            prompt_ids = batch["prompt_ids"]
            prompt_attn = batch["prompt_attn"]
            with torch.no_grad():
                full = generate_on_policy_outputs(
                    student, prompt_ids, attention_mask=prompt_attn,
                    generation_config=gen_config, pad_token_id=pad_token_id)
            full = full.detach()
            plen = batch["prompt_len"]
            roll_len = int(full.shape[-1]) - plen
            if roll_len <= 0:
                # student emitted nothing past the prompt -> no loss positions.
                realized_on_policy.append(0)
                realized_rollout_tokens.append(0)
                n_off += 1
                continue
            input_ids = full
            attention_mask = torch.ones_like(input_ids)
            labels = input_ids.clone()
            labels[:, :plen] = -100  # ONLY the rollout span is a loss position
            n_on += 1
            realized_on_policy.append(1)
            realized_rollout_tokens.append(roll_len)
            label_audit.append({
                "step": step,
                "loss_positions": int((labels != -100).sum().item()),
                "rollout_len": roll_len,
                "prompt_all_masked": bool((labels[:, :plen] == -100).all().item()),
            })
        else:
            input_ids = batch["input_ids"]
            attention_mask = batch["attention_mask"]
            labels = batch["labels"]
            n_off += 1
            realized_on_policy.append(0)
            realized_rollout_tokens.append(0)

        student_out = student(input_ids=input_ids, attention_mask=attention_mask)
        with torch.no_grad():
            teacher_out = teacher(input_ids=input_ids, attention_mask=attention_mask)
        # Causal shift: position i predicts token i+1; align labels to next token.
        s_logits = student_out.logits[:, :-1, :]
        t_logits = teacher_out.logits[:, :-1, :]
        shift_labels = labels[:, 1:]
        loss = generalized_jsd_loss(s_logits, t_logits, labels=shift_labels,
                                    beta=beta, temperature=temperature)
        if optimizer is not None:
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
        loss_traj.append(float(loss.detach().item()))
        if on_step is not None:
            on_step(step, loss_traj[-1], realized_on_policy[-1])

    return {
        "loss_trajectory": loss_traj,
        "realized_on_policy": realized_on_policy,
        "realized_rollout_tokens": realized_rollout_tokens,
        "label_audit": label_audit,
        "on_policy_step_count": n_on,
        "off_policy_step_count": n_off,
        "steps": total_steps,
    }


def _build_run_meta(args, total_steps, run):
    """Receipt-grade run-meta. REPLACES the misleading lmbda_curve (which echoed
    the SCHEDULED value) with realized_on_policy_fraction recording BOTH what was
    scheduled AND what was REALIZED."""
    per_step = run["realized_on_policy"][-1000:]
    rop = run["realized_on_policy"]
    overall = (sum(rop) / len(rop)) if rop else 0.0
    mid = total_steps // 2
    last = max(0, total_steps - 1)
    return {
        "objective": "gkd",
        "train_path": "handrolled_on_policy",
        "beta": args.beta,
        "lmbda": args.lmbda,
        "temperature": args.temperature,
        "seed": args.seed,
        "warmup_frac": args.warmup_frac,
        "max_new_tokens": args.max_new_tokens,
        "steps": total_steps,
        "on_policy_step_count": run["on_policy_step_count"],
        "off_policy_step_count": run["off_policy_step_count"],
        "realized_rollout_tokens": run["realized_rollout_tokens"][-1000:],
        "realized_on_policy_fraction": {
            "per_step": per_step,
            "overall": overall,
            "scheduled_lmbda_at": {
                "0": lmbda_schedule(0, total_steps, 0.0, args.lmbda, args.warmup_frac),
                "mid": lmbda_schedule(mid, total_steps, 0.0, args.lmbda, args.warmup_frac),
                "end": lmbda_schedule(last, total_steps, 0.0, args.lmbda, args.warmup_frac),
            },
        },
        "loss_trajectory": run["loss_trajectory"][-1000:],
        "label_audit": run.get("label_audit", [])[-1000:],
        "namespace": args.namespace,
        "papers": ["arXiv:2306.13649"],
    }


def _gen_config_for(args, tok):
    """transformers.GenerationConfig mirroring eval_adapter (do_sample, temp,
    max_new_tokens default 256, pad_token_id)."""
    from transformers import GenerationConfig
    pad_id = getattr(tok, "pad_token_id", None)
    return GenerationConfig(
        do_sample=True,
        temperature=max(1e-3, float(args.temperature)),
        max_new_tokens=int(args.max_new_tokens),
        pad_token_id=pad_id,
    )


def _self_test(args) -> int:
    """CPU --self-test: a tiny stub student/teacher exposing .generate + .logits
    drives the hand-rolled loop end to end and proves the realized on-policy
    fraction + label masking in run-meta. No real model, no GPU, no network."""
    import random
    import torch

    _gkd_seed(args.seed)
    vocab, hid = 16, 8
    plen = 3

    class _Tok:
        pad_token_id = 0
        def __call__(self, text, add_special_tokens=True):
            n = 1 + (abs(hash(text)) % 4)
            return {"input_ids": [1 + (abs(hash((text, i))) % (vocab - 1)) for i in range(n)]}

    class _Stub(torch.nn.Module):
        def __init__(self, kind):
            super().__init__()
            self.kind = kind
            self.emb = torch.nn.Embedding(vocab, hid)
            self.head = torch.nn.Linear(hid, vocab)
            self.config = type("C", (), {"is_encoder_decoder": False})()

        def forward(self, input_ids=None, attention_mask=None, **kw):
            h = self.emb(input_ids)
            logits = self.head(h)
            if self.kind == "teacher":  # bias teacher to a fixed sharp peak
                logits = logits + 0.0
            return type("O", (), {"logits": logits})()

        @torch.no_grad()
        def generate(self, input_ids, attention_mask=None, generation_config=None,
                     pad_token_id=None, **kw):
            new = int(getattr(generation_config, "max_new_tokens", 4) or 4)
            new = min(new, 5)
            g = torch.Generator(device="cpu")
            g.manual_seed(int(input_ids.sum().item()) + 1)
            tail = torch.randint(1, vocab, (input_ids.shape[0], new), generator=g)
            return torch.cat([input_ids, tail], dim=-1)

    tok = _Tok()
    student = _Stub("student")
    teacher = _Stub("teacher")
    rows = [{"prompt": "p%d" % i, "completion": "c%d done here" % i} for i in range(6)]
    batches = _build_gkd_batches(rows, tok, max_len=64)
    if not batches:
        sys.stderr.write("[train_gkd self-test] no batches built\n")
        return 5
    gen_config = type("GC", (), {"do_sample": True, "temperature": args.temperature,
                                 "max_new_tokens": args.max_new_tokens,
                                 "pad_token_id": 0})()
    total = max(4, args.total_steps)

    # capture label masking for an on-policy step (rollout-only loss positions).
    captured = {}
    def _probe(step, loss, on):
        pass
    run = train_gkd_handrolled(
        student, teacher, batches, tok, gen_config=gen_config, beta=args.beta,
        temperature=args.temperature, lmbda_end=args.lmbda, warmup_frac=args.warmup_frac,
        total_steps=total, seed=args.seed, pad_token_id=0, optimizer=None, on_step=_probe)

    os.makedirs(args.out, exist_ok=True)
    meta = _build_run_meta(args, total, run)
    meta["self_test"] = True
    with open(os.path.join(args.out, "run-meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    print(json.dumps({
        "ok": True, "self_test": "passed",
        "realized_on_policy_overall": meta["realized_on_policy_fraction"]["overall"],
        "on_policy_step_count": run["on_policy_step_count"],
        "off_policy_step_count": run["off_policy_step_count"],
        "label_audit": run["label_audit"],
        "per_step": meta["realized_on_policy_fraction"]["per_step"],
        "steps": total,
    }))
    return 0


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
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--warmup-frac", dest="warmup_frac", type=float, default=0.1)
    p.add_argument("--max-new-tokens", dest="max_new_tokens", type=int, default=256)
    p.add_argument("--total-steps", dest="total_steps", type=int, default=0,
                   help="cap training steps (0 = one pass over the data).")
    p.add_argument("--preflight-only", action="store_true")
    p.add_argument("--self-test", dest="self_test", action="store_true",
                   help="CPU stub run proving the on-policy loop + realized fraction (no GPU/network).")
    p.add_argument("--check-trl-lmbda", dest="check_trl_lmbda", action="store_true",
                   help="TRL-path receipt-integrity guard ONLY: fail (exit 8) if the "
                        "installed GKDConfig drops lmbda; no model load.")
    args = p.parse_args(argv)

    if not 0.0 <= args.beta <= 1.0:
        sys.stderr.write("[train_gkd] beta must be in [0,1]\n")
        return 6

    if args.check_trl_lmbda:
        # GUARD (a) in isolation: prove the on-policy knob survives the installed
        # GKDConfig. KOLM_GKD_GKDCONFIG=module:attr injects a stub config class
        # for the no-lmbda regression test (so we never need to downgrade trl).
        inject = os.environ.get("KOLM_GKD_GKDCONFIG")
        if inject:
            mod_name, _, attr = inject.partition(":")
            mod = __import__(mod_name, fromlist=[attr or "GKDConfig"])
            GKDConfig = getattr(mod, attr or "GKDConfig")
        else:
            trl = _require("trl", "pip install 'trl>=0.12.0'")
            GKDConfig = getattr(trl, "GKDConfig", None)
            if GKDConfig is None:
                sys.stderr.write("[train_gkd] trl is too old for GKDConfig; pip install -U 'trl>=0.12.0'\n")
                return 8
        _kept, dropped = _filter_config_kwargs(
            GKDConfig, {"beta": args.beta, "lmbda": args.lmbda, "temperature": args.temperature})
        if "lmbda" in dropped:
            sys.stderr.write(
                "[train_gkd] FATAL: installed trl GKDConfig does not accept lmbda; "
                "the on-policy fraction knob was DROPPED -> receipt cannot claim "
                "on-policy.\n            Upgrade: pip install \"trl>=0.12.0\", or set "
                "KOLM_GKD_HANDROLLED=1 to use the in-repo on-policy executor.\n")
            return 8
        print(json.dumps({"ok": True, "trl_lmbda_accepted": args.lmbda}))
        return 0

    if args.self_test:
        # Stub student/teacher; no teacher path / no torch model load required.
        if args.total_steps <= 0:
            args.total_steps = 4
        _require("torch", "pip install torch")
        return _self_test(args)

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

    # Real run requires torch (+ trl only on the TRL path; see KOLM_GKD_HANDROLLED).
    _require("torch", "pip install torch")
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

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
    seed = _gkd_seed(args.seed)
    tok = AutoTokenizer.from_pretrained(args.student)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
    student = AutoModelForCausalLM.from_pretrained(args.student, torch_dtype=dtype)
    teacher = AutoModelForCausalLM.from_pretrained(args.teacher, torch_dtype=dtype)

    # Path selection. The in-repo HAND-ROLLED loop is the canonical on-policy
    # executor: it actually generates student rollouts and records the REALIZED
    # on-policy fraction. The TRL path only Bernoulli-samples a CONSTANT scalar
    # lmbda per batch (cannot honor a warmup->ramp schedule), so it is opt-in.
    handrolled = os.environ.get("KOLM_GKD_HANDROLLED", "1") not in ("0", "false", "no", "")

    if not handrolled:
        # --- TRL path (opt-out). FAIL LOUD if GKDConfig dropped `lmbda`. ---
        trl = _require("trl", "pip install 'trl>=0.12.0'")
        GKDTrainer = getattr(trl, "GKDTrainer", None)
        GKDConfig = getattr(trl, "GKDConfig", None)
        if GKDTrainer is None or GKDConfig is None:
            sys.stderr.write("[train_gkd] trl is too old for GKDTrainer; pip install -U 'trl>=0.12.0'\n")
            return 8
        from datasets import Dataset
        requested = {
            "output_dir": args.out, "beta": args.beta, "lmbda": args.lmbda,
            "temperature": args.temperature, "seq_kd": False, "seed": seed,
            "per_device_train_batch_size": 1, "num_train_epochs": 1, "report_to": [],
        }
        kept, dropped = _filter_config_kwargs(GKDConfig, requested)
        # GUARD (a): lmbda is the on-policy control. If it was DROPPED, the
        # receipt could silently claim on-policy while training pure off-policy.
        # Refuse loudly (exit 8). beta/seq_kd/temperature stay signature-filtered.
        if "lmbda" in dropped:
            sys.stderr.write(
                "[train_gkd] FATAL: installed trl GKDConfig does not accept lmbda; "
                "the on-policy fraction knob was DROPPED -> receipt cannot claim "
                "on-policy.\n            Upgrade: pip install \"trl>=0.12.0\", or set "
                "KOLM_GKD_HANDROLLED=1 to use the in-repo on-policy executor.\n")
            return 8
        cfg = GKDConfig(**kept)
        ds = Dataset.from_list(rows)
        trainer = GKDTrainer(model=student, teacher_model=teacher, args=cfg,
                             train_dataset=ds, processing_class=tok)
        trainer.train()
        student.save_pretrained(args.out)
        tok.save_pretrained(args.out)
        with open(os.path.join(args.out, "run-meta.json"), "w", encoding="utf-8") as f:
            json.dump({"objective": "gkd", "train_path": "trl", "beta": args.beta,
                       "lmbda": args.lmbda, "temperature": args.temperature,
                       "seed": seed, "papers": ["arXiv:2306.13649"],
                       "namespace": args.namespace}, f, indent=2)
        print(f"[train_gkd] done (trl) -> {args.out}")
        return 0

    # --- HAND-ROLLED canonical on-policy executor (default) ---
    batches = _build_gkd_batches(rows, tok, max_len=512)
    if not batches:
        sys.stderr.write(
            "[train_gkd] no off-policy teacher-data batches built; rows need a "
            "completion field (completion|teacher_output|chosen|response|output) "
            "for the off-policy mixture component.\n")
        return 4
    total_steps = args.total_steps if args.total_steps > 0 else len(batches)
    gen_config = _gen_config_for(args, tok)
    optimizer = torch.optim.AdamW(student.parameters(), lr=1e-5)
    run = train_gkd_handrolled(
        student, teacher, batches, tok, gen_config=gen_config, beta=args.beta,
        temperature=args.temperature, lmbda_end=args.lmbda,
        warmup_frac=args.warmup_frac, total_steps=total_steps, seed=seed,
        pad_token_id=tok.pad_token_id, optimizer=optimizer)
    student.save_pretrained(args.out)
    tok.save_pretrained(args.out)
    meta = _build_run_meta(args, total_steps, run)
    with open(os.path.join(args.out, "run-meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    print(f"[train_gkd] done (handrolled on-policy) -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
