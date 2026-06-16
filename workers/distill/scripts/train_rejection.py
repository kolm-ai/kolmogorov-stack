#!/usr/bin/env python3
# workers/distill/scripts/train_rejection.py
#
# FINALIZED-C4 — CLI entry for rejection-sampling / best-of-N distillation SFT.
#
# Pipeline:
#   1. Load a candidates JSONL (one row per prompt, carrying N sampled
#      candidates + the verifiable column).
#   2. Score every candidate with apps.trainer.reject_sample.select_accepted,
#      which reuses apps.trainer.grpo.REWARD_FUNCTIONS + the kolm_verifier
#      reward (the SAME reward path the GRPO/RLVR trainer uses - NOT the K-score
#      ship gate, whose accuracy axis is eval_adapter._judge_local recall
#      overlap; the two are different functions, do not conflate them).
#   3. Keep the best (or first above-threshold) candidate per prompt; reject
#      prompts whose best candidate misses the floor.
#   4. SFT the student on the ACCEPTED set only (same instruction format as
#      train_lora.py).
#   5. Write run-meta.json surfacing accept_rate, mean_candidate_score,
#      num_candidates (N), threshold, selection, and the ledger hash.
#
# The scoring + selection half is GPU-free and runs under --preflight-only or
# --select-only so CI can prove the accept/reject path without torch.
#
# CLI:
#   python train_rejection.py --candidates <jsonl> --student <path> --out <dir>
#     --reward kolm_verifier --num-candidates 8 --threshold 0.5 --selection best
#     [--temperature 0.8] [--preflight-only] [--select-only]

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
        sys.stderr.write(f"[train_rejection] missing dependency '{mod_name}'.\n")
        sys.stderr.write(f"                  install hint: {install_hint}\n")
        sys.exit(3)


def _load_candidates(path):
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for ln in f:
            ln = ln.strip()
            if not ln:
                continue
            try:
                obj = json.loads(ln)
            except json.JSONDecodeError:
                continue
            if "candidates" not in obj or not isinstance(obj["candidates"], list):
                continue
            rows.append(obj)
    return rows


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="kolm rejection-sampling / best-of-N distillation SFT")
    p.add_argument("--candidates", required=True)
    p.add_argument("--student", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--reward", default="kolm_verifier",
                   help="reward family: kolm_verifier|math_checker|schema_validator|code_exec|format")
    p.add_argument("--num-candidates", type=int, default=8)
    p.add_argument("--threshold", type=float, default=0.5)
    p.add_argument("--selection", default="best", choices=["best", "threshold"])
    p.add_argument("--temperature", type=float, default=0.8)
    p.add_argument("--lora-rank", type=int, default=16)
    p.add_argument("--lora-alpha", type=int, default=32)
    p.add_argument("--epochs", type=int, default=3)
    p.add_argument("--batch-size", type=int, default=4)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--max-length", type=int, default=512)
    p.add_argument("--namespace", default="default")
    p.add_argument("--tenant", default="local")
    p.add_argument("--preflight-only", action="store_true",
                   help="resolve reward + config, then exit 0 (no scoring, no training)")
    p.add_argument("--select-only", action="store_true",
                   help="score + select accepted set + write run-meta, but SKIP the SFT (GPU-free)")
    args = p.parse_args(argv)

    if not os.path.exists(args.candidates):
        sys.stderr.write(f"[train_rejection] candidates file not found: {args.candidates}\n")
        return 4

    os.makedirs(args.out, exist_ok=True)

    # Resolve the selection routine FIRST (GPU-free; proves the reward path).
    try:
        from apps.trainer.reject_sample import select_accepted, SELECTION_MODES  # noqa: F401
    except Exception as e:
        sys.stderr.write(f"[train_rejection] reject_sample import failed: {e}\n")
        return 5

    if args.preflight_only:
        meta = {
            "preflight": "ok",
            "reward": args.reward,
            "num_candidates": args.num_candidates,
            "threshold": args.threshold,
            "selection": args.selection,
            "temperature": args.temperature,
        }
        print(json.dumps({"ok": True, **meta}))
        return 0

    rows = _load_candidates(args.candidates)
    if not rows:
        sys.stderr.write("[train_rejection] no candidate groups loaded\n")
        return 4

    # ── Score + select the accepted set (REUSES the K-score reward path). ──
    try:
        sel = select_accepted(
            rows,
            family=args.reward,
            threshold=args.threshold,
            selection=args.selection,
        )
    except ValueError as e:
        sys.stderr.write(f"[train_rejection] selection failed: {e}\n")
        return 5

    accepted = sel["accepted"]
    stats = sel["stats"]
    print(
        f"[train_rejection] accept_rate={stats['accept_rate']:.3f} "
        f"({stats['accepted']}/{stats['prompts']}) "
        f"mean_candidate_score={stats['mean_candidate_score']:.3f} "
        f"N<={stats['num_candidates_max']} threshold={stats['threshold']} "
        f"selection={stats['selection']} reward={stats['family']}"
    )

    # Persist the accepted pairs + the full ledger so the receipt chain is
    # auditable offline (the ledger_hash in run-meta pins them).
    accepted_path = os.path.join(args.out, "accepted-pairs.jsonl")
    with open(accepted_path, "w", encoding="utf-8") as f:
        for a in accepted:
            f.write(json.dumps({
                "id": a.get("id"),
                "input": a.get("prompt"),
                "teacher_output": a.get("completion"),
                "accept_score": a.get("score"),
            }) + "\n")
    ledger_path = os.path.join(args.out, "selection-ledger.jsonl")
    with open(ledger_path, "w", encoding="utf-8") as f:
        for l in sel["ledger"]:
            f.write(json.dumps(l) + "\n")

    run_meta = {
        "method": "rejection_sampling",
        "papers": ["arXiv:2203.14465", "arXiv:2304.06767", "arXiv:2308.01825", "arXiv:2407.14622"],
        "reward": args.reward,
        "num_candidates": args.num_candidates,
        "num_candidates_observed_max": stats["num_candidates_max"],
        "threshold": args.threshold,
        "selection": args.selection,
        "temperature": args.temperature,
        "accept_rate": stats["accept_rate"],
        "mean_candidate_score": stats["mean_candidate_score"],
        "mean_accepted_score": stats["mean_accepted_score"],
        "prompts": stats["prompts"],
        "accepted": stats["accepted"],
        "rejected": stats["rejected"],
        "candidates_total": stats["candidates_total"],
        "ledger_hash": stats["ledger_hash"],
        "accepted_pairs_path": os.path.basename(accepted_path),
        "selection_ledger_path": os.path.basename(ledger_path),
        "namespace": args.namespace,
        "ml_pipeline_run": False,  # flipped to True only after the SFT below
    }

    if args.select_only:
        run_meta["note"] = "select-only — accepted set written; SFT skipped (GPU-free path)."
        with open(os.path.join(args.out, "run-meta.json"), "w", encoding="utf-8") as f:
            json.dump(run_meta, f, indent=2)
        print(f"[train_rejection] select-only done -> {args.out}")
        return 0

    if not accepted:
        run_meta["note"] = "no candidate cleared the threshold; nothing to SFT."
        with open(os.path.join(args.out, "run-meta.json"), "w", encoding="utf-8") as f:
            json.dump(run_meta, f, indent=2)
        sys.stderr.write("[train_rejection] accepted set is EMPTY (no candidate >= threshold); "
                         "lower --threshold or raise --num-candidates.\n")
        return 6

    # ── SFT on the ACCEPTED set only. Same instruction format + LoRA path as
    # train_lora.py so the two SFT modes produce comparable adapters. ──
    torch = _require("torch", "pip install torch")
    _require("transformers", "pip install transformers")
    _require("peft", "pip install peft")
    _require("datasets", "pip install datasets")
    _require("accelerate", "pip install accelerate")

    from transformers import (AutoModelForCausalLM, AutoTokenizer,
                              TrainingArguments, Trainer,
                              DataCollatorForLanguageModeling)
    from peft import LoraConfig, get_peft_model, TaskType
    from datasets import Dataset

    _MODEL_ALIASES = {
        "qwen2.5-0.5b": "Qwen/Qwen2.5-0.5B-Instruct",
        "qwen2.5-1.5b": "Qwen/Qwen2.5-1.5B-Instruct",
        "qwen2.5-3b": "Qwen/Qwen2.5-3B-Instruct",
        "llama-3.2-1b": "meta-llama/Llama-3.2-1B-Instruct",
        "llama-3.2-3b": "meta-llama/Llama-3.2-3B-Instruct",
    }
    student_base = _MODEL_ALIASES.get(str(args.student).lower(), args.student)

    tok = AutoTokenizer.from_pretrained(student_base)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    def to_example(a):
        prompt = str(a["prompt"])
        completion = str(a["completion"])
        text = f"<|user|>\n{prompt}\n<|assistant|>\n{completion}{tok.eos_token}"
        enc = tok(text, truncation=True, max_length=args.max_length, padding="max_length")
        enc["labels"] = enc["input_ids"].copy()
        return enc

    ds = Dataset.from_list(accepted)
    ds = ds.map(to_example, remove_columns=ds.column_names)

    dtype = torch.bfloat16 if (hasattr(torch, "cuda") and torch.cuda.is_available()) else torch.float32
    base = AutoModelForCausalLM.from_pretrained(student_base, torch_dtype=dtype, device_map="auto")
    lora_cfg = LoraConfig(
        r=args.lora_rank, lora_alpha=args.lora_alpha,
        task_type=TaskType.CAUSAL_LM, bias="none", lora_dropout=0.05,
    )
    model = get_peft_model(base, lora_cfg)
    model.print_trainable_parameters()

    training = TrainingArguments(
        output_dir=args.out,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        learning_rate=args.lr,
        save_strategy="epoch",
        logging_steps=10,
        report_to=[],
    )
    trainer = Trainer(
        model=model, args=training, train_dataset=ds,
        data_collator=DataCollatorForLanguageModeling(tok, mlm=False),
    )
    trainer.train()
    model.save_pretrained(args.out)
    tok.save_pretrained(args.out)

    run_meta["ml_pipeline_run"] = True
    run_meta["student_base"] = student_base
    run_meta["accepted_trained_on"] = len(accepted)
    run_meta["lora_rank"] = args.lora_rank
    run_meta["lora_alpha"] = args.lora_alpha
    run_meta["epochs"] = args.epochs
    with open(os.path.join(args.out, "run-meta.json"), "w", encoding="utf-8") as f:
        json.dump(run_meta, f, indent=2)
    print(f"[train_rejection] done -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
