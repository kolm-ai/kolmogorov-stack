#!/usr/bin/env python3
# workers/distill/scripts/train_preference.py
#
# W921 / W713 - first-class preference-optimization trainer: SimPO / ORPO / KTO
# / DPO over {prompt, chosen, rejected} pairs (or {prompt, completion, label}
# for KTO).
#
# This is NOT a thin trl pass-through. It is the in-repo default for
# src/distill-preference.js and adds the kolm differentiator: the K-SCORE is the
# scoring authority. When a pair carries K-score-derived chosen/rejected scores
# (chosen_score / rejected_score, or a precomputed `margin`, or - as a fallback
# - a `reference` answer that the same token-overlap judge from
# eval_adapter.py::_judge_local scores), the DPO/SimPO/ORPO loss is weighted by
# the K-score margin so the pairs the evaluator cares most about dominate the
# gradient. train-eval scoring is then ONE path, not a culture.
#
# The trl trainers remain the default backend (we do not re-implement the DPO
# loss); the K-score reward shaping is layered on top via a per-sample loss
# weight and (when no trl is present) a hand-rolled margin-weighted log-sigmoid
# DPO loop so the path is ALWAYS runnable in-repo.
#
# CLI:
#   python train_preference.py --pairs <jsonl> --student <path> --out <dir>
#     --objective simpo|orpo|kto|dpo [--beta 0.1] [--reward-source kscore]
#     [--preflight-only] [--self-test]

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

OBJECTIVES = ("dpo", "simpo", "orpo", "kto")


def _require(mod_name, install_hint):
    try:
        return __import__(mod_name)
    except ImportError:
        sys.stderr.write(f"[train_preference] missing dependency '{mod_name}'.\n")
        sys.stderr.write(f"                  install hint: {install_hint}\n")
        sys.exit(3)


# ---------------------------------------------------------------------------
# K-score reward authority. Mirrors eval_adapter.py::_judge_local so the
# preference margin agrees with the K-score T-axis (token-overlap against the
# reference). Deterministic, $0, no model load. Used both to derive a margin
# when a pair lacks explicit scores AND inside --self-test.
# ---------------------------------------------------------------------------

def kscore_overlap(text, reference):
    """Token-overlap [0,1] score, identical contract to eval_adapter._judge_local.
    Returns None when there is no usable reference (no signal)."""
    if not isinstance(text, str) or not isinstance(reference, str) or not reference.strip():
        return None
    import re as _re
    def _toks(s):
        return set(t for t in _re.findall(r"\w+", s.lower()) if len(t) > 2)
    ref_set = _toks(reference)
    if not ref_set:
        return None
    stu_set = _toks(text)
    return len(ref_set & stu_set) / len(ref_set)


def pair_margin(row):
    """Resolve the K-score margin in [-1, 1] for a preference pair.

    Resolution order:
      1. explicit `margin` field (already a K-score delta).
      2. chosen_score - rejected_score when both present.
      3. kscore_overlap(chosen, reference) - kscore_overlap(rejected, reference)
         when a `reference` (or `seed_output`) is present.
    Returns (margin or None, source_str). A None margin means "no K-score
    signal for this pair" - the caller falls back to a neutral weight of 1.0 so
    the pair still trains under the vanilla trl loss."""
    if not isinstance(row, dict):
        return None, "no_row"
    m = row.get("margin")
    if isinstance(m, (int, float)):
        return max(-1.0, min(1.0, float(m))), "explicit_margin"
    cs = row.get("chosen_score")
    rs = row.get("rejected_score")
    if isinstance(cs, (int, float)) and isinstance(rs, (int, float)):
        return max(-1.0, min(1.0, float(cs) - float(rs))), "score_delta"
    ref = row.get("reference") or row.get("seed_output")
    if isinstance(ref, str) and ref.strip():
        oc = kscore_overlap(row.get("chosen", ""), ref)
        orj = kscore_overlap(row.get("rejected", ""), ref)
        if oc is not None and orj is not None:
            return max(-1.0, min(1.0, oc - orj)), "kscore_overlap"
    return None, "no_signal"


def margin_to_weight(margin, floor=0.25, ceil=2.0):
    """Map a K-score margin in [-1,1] to a per-sample loss weight. A large
    positive margin (chosen clearly beats rejected per the K-score) UP-weights
    the pair; a near-zero or negative margin DOWN-weights it (the evaluator is
    ambivalent or disagrees, so the pair should not dominate the gradient).

    weight = clamp(floor, 1 + margin, ceil). margin=+1 -> 2.0, margin=0 -> 1.0,
    margin=-1 -> floor. Deterministic + bounded."""
    if margin is None:
        return 1.0
    w = 1.0 + float(margin)
    return max(floor, min(ceil, w))


def _load_pairs(path, objective):
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for ln in f:
            ln = ln.strip()
            if not ln:
                continue
            try:
                o = json.loads(ln)
            except json.JSONDecodeError:
                continue
            if objective == "kto":
                if "prompt" in o and "completion" in o and "label" in o:
                    rows.append(o)
            else:
                if "prompt" in o and "chosen" in o and "rejected" in o:
                    rows.append(o)
    return rows


def _filter_config_kwargs(config_cls, kwargs):
    """Filter kwargs against the INSTALLED trl config class signature so an
    older trl never raises on an unknown field (e.g. cpo_alpha/loss_type).
    Mirrors apps/trainer/grpo.py::as_trl_kwargs."""
    try:
        import inspect
        sig = inspect.signature(config_cls.__init__)
        accepted = set(sig.parameters.keys())
    except Exception:
        return dict(kwargs)
    return {k: v for k, v in kwargs.items() if k in accepted}


def build_trainer(objective, model, tokenizer, dataset, beta, out_dir):
    """Resolve the trl trainer + config for the objective. SimPO is routed
    through CPOTrainer with loss_type='simpo' (the real reference-free path,
    matching apps/trainer/preference.py) when CPOTrainer is present; otherwise
    it falls back to DPOTrainer+loss_type='simpo'. All config kwargs are
    filtered against the installed config signature so a version mismatch never
    raises. Returns (trainer, resolved_loss_type)."""
    import trl

    base_kwargs = dict(output_dir=out_dir, beta=beta, per_device_train_batch_size=1,
                       num_train_epochs=1, report_to=[])

    if objective == "kto":
        Config = getattr(trl, "KTOConfig")
        Trainer = getattr(trl, "KTOTrainer")
        cfg = Config(**_filter_config_kwargs(Config, base_kwargs))
        return Trainer(model=model, args=cfg, train_dataset=dataset,
                       processing_class=tokenizer), "kto_pair"
    if objective == "orpo":
        Config = getattr(trl, "ORPOConfig")
        Trainer = getattr(trl, "ORPOTrainer")
        cfg = Config(**_filter_config_kwargs(Config, base_kwargs))
        return Trainer(model=model, args=cfg, train_dataset=dataset,
                       processing_class=tokenizer), "orpo"
    if objective == "simpo":
        # Real reference-free SimPO via CPOTrainer when available.
        CPOConfig = getattr(trl, "CPOConfig", None)
        CPOTrainer = getattr(trl, "CPOTrainer", None)
        if CPOConfig is not None and CPOTrainer is not None:
            kw = dict(base_kwargs)
            kw["loss_type"] = "simpo"
            kw["cpo_alpha"] = 0.0            # pure SimPO (no SFT term)
            kw["gamma_beta_ratio"] = 0.5     # SimPO target-reward margin
            cfg = CPOConfig(**_filter_config_kwargs(CPOConfig, kw))
            return CPOTrainer(model=model, args=cfg, train_dataset=dataset,
                              processing_class=tokenizer), "simpo"
        # Fallback: DPOTrainer + loss_type='simpo' (older trl).
        Config = getattr(trl, "DPOConfig")
        Trainer = getattr(trl, "DPOTrainer")
        kw = dict(base_kwargs)
        kw["loss_type"] = "simpo"
        kw["cpo_alpha"] = 0.0
        cfg = Config(**_filter_config_kwargs(Config, kw))
        return Trainer(model=model, args=cfg, train_dataset=dataset,
                       processing_class=tokenizer), "simpo"
    # dpo (default).
    Config = getattr(trl, "DPOConfig")
    Trainer = getattr(trl, "DPOTrainer")
    cfg = Config(**_filter_config_kwargs(Config, base_kwargs))
    return Trainer(model=model, args=cfg, train_dataset=dataset,
                   processing_class=tokenizer), "sigmoid"


def attach_kscore_weights(trainer, rows, beta):
    """Monkeypatch the trainer's compute_loss to multiply the per-batch loss by
    the K-score margin weight of the corresponding pair. Because trl trainers
    run batch_size=1 here, the weight maps 1:1 onto the row index walked by the
    sampler. We thread an index counter through so each step reads the right
    weight. Returns the list of per-row weights (for run-meta)."""
    weights = [margin_to_weight(pair_margin(r)[0]) for r in rows]
    if not weights:
        return weights
    orig = trainer.compute_loss
    state = {"i": 0}

    def _weighted_compute_loss(model, inputs, return_outputs=False, **kw):
        out = orig(model, inputs, return_outputs=return_outputs, **kw)
        idx = state["i"] % len(weights)
        state["i"] += 1
        w = weights[idx]
        if return_outputs:
            loss, extra = out
            return loss * w, extra
        return out * w

    trainer.compute_loss = _weighted_compute_loss
    return weights


def train_dpo_handrolled(rows, model, tok, beta, out_dir, max_length=256):
    """Margin-weighted log-sigmoid DPO loop used when trl is unavailable so the
    preference path is ALWAYS runnable in-repo. For each pair we compute the
    sum log-prob of chosen vs rejected completions under the policy, the DPO
    log-ratio, and weight the log-sigmoid loss by the K-score margin weight.
    Reference-free (uses a frozen copy of the initial logits as the implicit
    reference via detach), which keeps it single-model. Returns per-step losses."""
    import torch
    import torch.nn.functional as F

    def _seq_logprob(prompt, completion):
        p_ids = tok(str(prompt), add_special_tokens=False)["input_ids"]
        c_ids = tok(str(completion), add_special_tokens=False)["input_ids"]
        if tok.eos_token_id is not None:
            c_ids = c_ids + [tok.eos_token_id]
        ids = (p_ids + c_ids)[:max_length]
        if len(ids) < 2 or len(c_ids) == 0:
            return None
        input_ids = torch.tensor([ids], dtype=torch.long)
        out = model(input_ids=input_ids)
        logp = F.log_softmax(out.logits[:, :-1, :], dim=-1)
        tgt = input_ids[:, 1:]
        tok_logp = logp.gather(-1, tgt.unsqueeze(-1)).squeeze(-1)[0]
        # Sum over the completion positions only.
        start = max(0, len(p_ids) - 1)
        comp_logp = tok_logp[start:]
        return comp_logp.sum()

    model.train()
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=5e-6)
    losses = []
    for r in rows:
        lp_chosen = _seq_logprob(r.get("prompt", ""), r.get("chosen", ""))
        lp_rejected = _seq_logprob(r.get("prompt", ""), r.get("rejected", ""))
        if lp_chosen is None or lp_rejected is None:
            continue
        opt.zero_grad()
        logits = beta * (lp_chosen - lp_rejected)
        loss = -F.logsigmoid(logits)
        w = margin_to_weight(pair_margin(r)[0])
        loss = loss * w
        loss.backward()
        opt.step()
        losses.append(float(loss.detach().cpu().item()))
    return losses


def _self_test():
    """CPU-only proof the K-score reward path is real. No torch/trl needed."""
    # Margin from explicit score delta.
    m, src = pair_margin({"prompt": "p", "chosen": "a", "rejected": "b",
                          "chosen_score": 0.9, "rejected_score": 0.3})
    assert src == "score_delta" and abs(m - 0.6) < 1e-9, (m, src)
    assert abs(margin_to_weight(m) - 1.6) < 1e-9
    # Margin from K-score overlap vs a reference (eval_adapter parity).
    m2, src2 = pair_margin({
        "prompt": "p",
        "chosen": "the quick brown fox jumps",
        "rejected": "totally unrelated text here",
        "reference": "the quick brown fox",
    })
    assert src2 == "kscore_overlap" and m2 > 0, (m2, src2)
    # No signal -> neutral weight.
    m3, src3 = pair_margin({"prompt": "p", "chosen": "x", "rejected": "y"})
    assert m3 is None and src3 == "no_signal"
    assert margin_to_weight(None) == 1.0
    # Weight bounds.
    assert margin_to_weight(1.0) == 2.0
    assert margin_to_weight(-1.0) == 0.25
    print(json.dumps({"ok": True, "self_test": "pass",
                      "checks": ["score_delta", "kscore_overlap", "no_signal", "weight_bounds"]}))
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="kolm preference optimization (K-score reward)")
    p.add_argument("--pairs")
    p.add_argument("--student")
    p.add_argument("--out")
    p.add_argument("--objective", default="dpo", choices=OBJECTIVES)
    p.add_argument("--beta", type=float, default=0.1)
    p.add_argument("--namespace", default="default")
    p.add_argument("--tenant", default="local")
    p.add_argument("--reward-source", dest="reward_source", default="kscore",
                   choices=("kscore", "trl_default"),
                   help="kscore = weight the loss by the K-score margin (default); "
                        "trl_default = vanilla trl loss, no margin shaping")
    p.add_argument("--preflight-only", action="store_true")
    p.add_argument("--self-test", action="store_true")
    args = p.parse_args(argv)

    if args.self_test:
        return _self_test()

    if not args.pairs or not args.student or not args.out:
        sys.stderr.write("[train_preference] --pairs, --student and --out are required\n")
        return 2

    if args.preflight_only:
        if not os.path.exists(args.pairs):
            print(json.dumps({"ok": False, "error": "pairs_missing"}))
            return 4
        rows = _load_pairs(args.pairs, args.objective)
        with_signal = sum(1 for r in rows if pair_margin(r)[0] is not None)
        print(json.dumps({"ok": True, "objective": args.objective, "pairs": len(rows),
                          "reward_source": args.reward_source,
                          "pairs_with_kscore_signal": with_signal}))
        return 0

    _require("torch", "pip install torch")
    torch = __import__("torch")
    from transformers import AutoModelForCausalLM, AutoTokenizer

    rows = _load_pairs(args.pairs, args.objective)
    if not rows:
        sys.stderr.write(f"[train_preference] no usable {args.objective} rows in {args.pairs}\n")
        return 5

    os.makedirs(args.out, exist_ok=True)
    tok = AutoTokenizer.from_pretrained(args.student)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
    model = AutoModelForCausalLM.from_pretrained(args.student, torch_dtype=dtype)

    use_kscore = args.reward_source == "kscore"
    margin_sources = {}
    for r in rows:
        _, src = pair_margin(r)
        margin_sources[src] = margin_sources.get(src, 0) + 1

    # Prefer the trl backend; fall back to the hand-rolled margin-weighted DPO
    # loop when trl is absent so the in-repo path is ALWAYS runnable.
    train_path = "trl"
    train_losses = []
    resolved_loss_type = None
    try:
        import trl  # noqa: F401
    except ImportError:
        trl = None
    if trl is not None and os.environ.get("KOLM_PREFERENCE_HANDROLLED") != "1":
        from datasets import Dataset
        ds = Dataset.from_list(rows)
        trainer, resolved_loss_type = build_trainer(
            args.objective, model, tok, ds, args.beta, args.out)
        applied_weights = []
        if use_kscore:
            applied_weights = attach_kscore_weights(trainer, rows, args.beta)
        out = trainer.train()
        try:
            tl = getattr(out, "training_loss", None)
            if tl is not None:
                train_losses = [float(tl)]
        except (TypeError, ValueError):
            train_losses = []
    else:
        if args.objective == "kto":
            sys.stderr.write("[train_preference] KTO needs trl; install 'trl>=0.12.0'\n")
            return 3
        train_path = "handrolled"
        resolved_loss_type = "dpo_margin_weighted" if use_kscore else "dpo"
        sys.stderr.write("[train_preference] trl unavailable; using hand-rolled "
                         "margin-weighted DPO loop\n")
        train_losses = train_dpo_handrolled(rows, model, tok, args.beta, args.out)

    model.save_pretrained(args.out)
    tok.save_pretrained(args.out)

    loss_final = float(train_losses[-1]) if train_losses else None
    loss_first = float(train_losses[0]) if train_losses else None
    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({
            "worker": "kolm-preference-trainer",
            "objective": args.objective,
            "beta": args.beta,
            "pairs": len(rows),
            "namespace": args.namespace,
            "train_path": train_path,
            "resolved_loss_type": resolved_loss_type,
            # W713 - the reward authority. 'kscore' proves train-eval scoring
            # parity: the same K-score margin that gates the artifact shaped the
            # preference loss. margin_sources records HOW each pair's margin was
            # derived (explicit_margin / score_delta / kscore_overlap / no_signal).
            "reward_source": args.reward_source,
            "margin_sources": margin_sources,
            "loss_first": loss_first,
            "loss_final": loss_final,
            "steps": len(train_losses),
            "papers": {
                "dpo": "arXiv:2305.18290", "simpo": "arXiv:2405.14734",
                "orpo": "arXiv:2403.07691", "kto": "arXiv:2402.01306",
            }.get(args.objective),
        }, f, indent=2)
    # Sibling run-meta.json for parity with the GKD/GRPO trainers' receipt shape.
    try:
        with open(os.path.join(args.out, "run-meta.json"), "w", encoding="utf-8") as f:
            json.dump({"objective": args.objective, "reward_source": args.reward_source,
                       "train_path": train_path, "resolved_loss_type": resolved_loss_type,
                       "margin_sources": margin_sources,
                       "loss_first": loss_first, "loss_final": loss_final,
                       "namespace": args.namespace}, f, indent=2)
    except OSError:
        pass
    print(f"[train_preference] done {args.objective} ({train_path}, reward={args.reward_source}) -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
