#!/usr/bin/env python3
# workers/distill/scripts/train_preference.py
#
# W921 — preference-optimization trainer entry: SimPO / ORPO / KTO / DPO over
# {prompt, chosen, rejected} pairs (or {prompt, completion, label} for KTO).
# Wraps trl's DPOTrainer / KTOTrainer / ORPOTrainer; SimPO is DPO with a
# reference-free loss_type. Writes manifest.json for the Node shell.
#
# This is the in-repo default for src/distill-preference.js (the W480 shell
# spawns $KOLM_PREFERENCE_TRAINER or this file).
#
# CLI:
#   python train_preference.py --pairs <jsonl> --student <path> --out <dir>
#     --objective simpo|orpo|kto|dpo [--beta 0.1] [--preflight-only]

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

OBJECTIVES = ("dpo", "simpo", "orpo", "kto")


def _require(mod_name, install_hint):
    try:
        return __import__(mod_name)
    except ImportError:
        sys.stderr.write(f"[train_preference] missing dependency '{mod_name}'.\n")
        sys.stderr.write(f"                  install hint: {install_hint}\n")
        sys.exit(3)


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


def build_trainer(objective, model, tokenizer, dataset, beta, out_dir):
    """Resolve the trl trainer + config for the objective. Returns trainer."""
    import trl

    if objective == "kto":
        Trainer = getattr(trl, "KTOTrainer")
        Config = getattr(trl, "KTOConfig")
        cfg = Config(output_dir=out_dir, beta=beta, per_device_train_batch_size=1,
                     num_train_epochs=1, report_to=[])
        return Trainer(model=model, args=cfg, train_dataset=dataset, processing_class=tokenizer)
    if objective == "orpo":
        Trainer = getattr(trl, "ORPOTrainer")
        Config = getattr(trl, "ORPOConfig")
        cfg = Config(output_dir=out_dir, beta=beta, per_device_train_batch_size=1,
                     num_train_epochs=1, report_to=[])
        return Trainer(model=model, args=cfg, train_dataset=dataset, processing_class=tokenizer)
    # dpo + simpo both go through DPOTrainer; simpo flips loss_type + ref-free.
    Trainer = getattr(trl, "DPOTrainer")
    Config = getattr(trl, "DPOConfig")
    kwargs = dict(output_dir=out_dir, beta=beta, per_device_train_batch_size=1,
                  num_train_epochs=1, report_to=[])
    if objective == "simpo":
        kwargs["loss_type"] = "simpo"
        kwargs["cpo_alpha"] = 0.0  # pure SimPO (no SFT term) when supported
    cfg = Config(**{k: v for k, v in kwargs.items()})
    return Trainer(model=model, args=cfg, train_dataset=dataset, processing_class=tokenizer)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="kolm preference optimization")
    p.add_argument("--pairs", required=True)
    p.add_argument("--student", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--objective", default="dpo", choices=OBJECTIVES)
    p.add_argument("--beta", type=float, default=0.1)
    p.add_argument("--namespace", default="default")
    p.add_argument("--tenant", default="local")
    p.add_argument("--preflight-only", action="store_true")
    args = p.parse_args(argv)

    if args.preflight_only:
        # Confirm the objective resolves + pairs parse, no model load.
        if not os.path.exists(args.pairs):
            print(json.dumps({"ok": False, "error": "pairs_missing"}))
            return 4
        rows = _load_pairs(args.pairs, args.objective)
        print(json.dumps({"ok": True, "objective": args.objective, "pairs": len(rows)}))
        return 0

    _require("torch", "pip install torch")
    _require("trl", "pip install 'trl>=0.12.0'")
    torch = __import__("torch")
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from datasets import Dataset

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
    ds = Dataset.from_list(rows)

    trainer = build_trainer(args.objective, model, tok, ds, args.beta, args.out)
    trainer.train()
    model.save_pretrained(args.out)
    tok.save_pretrained(args.out)

    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({
            "worker": "kolm-preference-trainer",
            "objective": args.objective,
            "beta": args.beta,
            "pairs": len(rows),
            "namespace": args.namespace,
            "papers": {
                "dpo": "arXiv:2305.18290", "simpo": "arXiv:2405.14734",
                "orpo": "arXiv:2403.07691", "kto": "arXiv:2402.01306",
            }.get(args.objective),
        }, f, indent=2)
    print(f"[train_preference] done {args.objective} -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
