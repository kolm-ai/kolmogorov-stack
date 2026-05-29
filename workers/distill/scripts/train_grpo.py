#!/usr/bin/env python3
# workers/distill/scripts/train_grpo.py
#
# W921 — CLI entry for GRPO / RLVR (verifiable-reward) fine-tuning. Wraps
# apps.trainer.grpo.grpo_trainer + REWARD_FUNCTIONS + a kolm_verifier_reward and
# writes a run-meta.json receipt. Fails fast + loud when trl/torch are absent.
#
# CLI:
#   python train_grpo.py --prompts <jsonl> --student <path> --out <dir>
#     --reward code_exec[,format] --num-generations 8 --loss-type grpo
#     [--sft-warmup-adapter <path>] [--max-completion-length 512] [--recipe r.json]
#
# The prompts JSONL columns (prompt + references|schemas|regexes|tests) are
# forwarded by trl to the reward functions. See src/distill-grpo.js
# buildPromptsJsonl for the writer.

from __future__ import annotations

import argparse
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

# Make apps.trainer importable from repo root.
_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, _REPO)


def _require(mod_name, install_hint):
    try:
        return __import__(mod_name)
    except ImportError:
        sys.stderr.write(f"[train_grpo] missing dependency '{mod_name}'.\n")
        sys.stderr.write(f"             install hint: {install_hint}\n")
        sys.exit(3)


def kolm_verifier_reward(prompts, completions, references=None, **kwargs):
    """Reward = the K-score-style local verifier on each completion. Mirrors the
    eval_adapter local judge: reward in [0,1] from token-overlap with the
    reference + structural sanity. Keeps train-eval scoring identical."""
    refs = references if references is not None else [None] * len(completions)
    out = []
    for c, ref in zip(completions, refs):
        text = c if isinstance(c, str) else str(c)
        score = 0.5
        low = text.lower()
        if "<think>" in low or "</think>" in low:
            score -= 0.3
        if any(p in low for p in ("i cannot", "i can't", "as an ai")):
            score -= 0.25
        if ref:
            a = set(text.lower().split())
            b = set(str(ref).lower().split())
            if a and b:
                inter = len(a & b)
                union = len(a | b)
                score += 0.3 * (inter / union if union else 0.0)
        out.append(max(0.0, min(1.0, score)))
    return out


def build_reward_funcs(reward_spec):
    """Resolve reward family names to callables from apps.trainer.grpo.
    reward_spec is a list of family names."""
    from apps.trainer.grpo import (
        REWARD_FUNCTIONS, make_format_reward,
    )
    funcs = []
    for name in reward_spec:
        name = name.strip()
        if name == "format":
            funcs.append(make_format_reward())
        elif name == "kolm_verifier":
            funcs.append(kolm_verifier_reward)
        elif name in REWARD_FUNCTIONS:
            funcs.append(REWARD_FUNCTIONS[name])
        else:
            raise ValueError(f"unknown reward family: {name}")
    if not funcs:
        raise ValueError("no reward functions resolved")
    return funcs


def _load_prompts(path):
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for ln in f:
            ln = ln.strip()
            if not ln:
                continue
            try:
                rows.append(json.loads(ln))
            except json.JSONDecodeError:
                continue
    return rows


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="kolm GRPO / RLVR fine-tune")
    p.add_argument("--prompts", required=True)
    p.add_argument("--student", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--reward", default="code_exec", help="comma-separated reward families")
    p.add_argument("--num-generations", type=int, default=8)
    p.add_argument("--loss-type", default="grpo", choices=["grpo", "bnpo", "dr_grpo"])
    p.add_argument("--sft-warmup-adapter", default=None)
    p.add_argument("--max-completion-length", type=int, default=512)
    p.add_argument("--recipe", default=None)
    p.add_argument("--namespace", default="default")
    p.add_argument("--tenant", default="local")
    p.add_argument("--preflight-only", action="store_true",
                   help="resolve reward funcs + config, then exit 0 (no training)")
    args = p.parse_args(argv)

    reward_spec = [r for r in args.reward.split(",") if r.strip()]

    # Resolve reward funcs FIRST (this is GPU-free and proves the path).
    try:
        from apps.trainer.grpo import GRPOTrainConfig, receipt_block  # noqa: F401
        reward_funcs = build_reward_funcs(reward_spec)
    except (ValueError, ImportError) as e:
        sys.stderr.write(f"[train_grpo] reward setup failed: {e}\n")
        return 5

    cfg = GRPOTrainConfig(
        num_generations=args.num_generations,
        max_completion_length=args.max_completion_length,
        output_dir=args.out,
    )

    if args.preflight_only:
        os.makedirs(args.out, exist_ok=True)
        meta = {
            "preflight": "ok",
            "reward_funcs": reward_spec,
            "loss_type": args.loss_type,
            "num_generations": args.num_generations,
            "max_completion_length": args.max_completion_length,
        }
        print(json.dumps({"ok": True, **meta}))
        return 0

    # Real run requires trl + torch + a model.
    _require("torch", "pip install torch")
    _require("trl", "pip install 'trl>=0.12.0'")
    torch = __import__("torch")
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from datasets import Dataset
    from apps.trainer.grpo import grpo_trainer

    rows = _load_prompts(args.prompts)
    if not rows:
        sys.stderr.write("[train_grpo] no prompts loaded\n")
        return 4

    os.makedirs(args.out, exist_ok=True)
    tok = AutoTokenizer.from_pretrained(args.student)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
    model = AutoModelForCausalLM.from_pretrained(args.student, torch_dtype=dtype)
    if args.sft_warmup_adapter:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, args.sft_warmup_adapter, is_trainable=True)

    ds = Dataset.from_list(rows)
    trainer = grpo_trainer(
        model=model, tokenizer=tok, train_dataset=ds,
        reward_funcs=reward_funcs, args=cfg,
    )
    trainer.train()
    model.save_pretrained(args.out)
    tok.save_pretrained(args.out)

    meta = receipt_block(cfg, reward_names=reward_spec, train_examples=len(rows))
    meta["loss_type"] = args.loss_type
    meta["namespace"] = args.namespace
    with open(os.path.join(args.out, "run-meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    print(f"[train_grpo] done -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
