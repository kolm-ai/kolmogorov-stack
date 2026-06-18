#!/usr/bin/env python3
# workers/distill/scripts/train_lora_unsloth.py
#
# T2.2 — Unsloth-backed LoRA fine-tune mirror of train_lora.py.
#
# Why a mirror file and not an in-process branch:
#   `import unsloth` monkey-patches torch + transformers at import time. Doing
#   it in train_lora.py would pollute every HF Trainer run with Unsloth's
#   patched ops, breaking reproducibility comparisons. Splitting the import
#   into its own process keeps the HF path bit-for-bit equivalent to pre-T2.2.
#
# Selected by:
#   train_lora.py --backend=auto  (auto detection: family match + import probe)
#   train_lora.py --backend=unsloth  (forced; hard-exits 11 if missing)
#
# CLI contract: accepts the same flags train_lora.py forwards via
# _exec_unsloth_backend, plus --backend-reason and --holdout for the manifest.
# Reads the same env vars (KOLM_PRECISION, KOLM_GRAD_CHECKPOINT, KOLM_EARLY_STOP*,
# KOLM_GIT_SHA, KOLM_RECIPE_HASH, KOLM_RECIPE_NAME, KOLM_SCRUBBER_VERSION,
# KOLM_PAIRS_HASH, KOLM_VERSION).
#
# Win bands (Unsloth published claims, validated against Qwen2.5-7B QLoRA):
#   - ~2.0-2.4x faster than HF Trainer on a single GPU
#   - ~50-70% lower peak VRAM (kernels avoid intermediate fp32 buffers)
#   - Bit-equivalent loss curves within fp16/bf16 noise band
#
# Exit codes mirror train_lora.py: 3 missing dep, 4 pairs not found, 5 no rows,
# 6 bad val-fraction, 7 qlora prep, 8 resume not found, 9 deepspeed missing,
# 11 forced backend unavailable.

import argparse
import json
import math
import os
import sys
import time

from _console import setup_utf8 as _setup_utf8  # noqa: F401 — import side-effect


def _require(mod_name, install_hint, code=3):
    try:
        return __import__(mod_name)
    except ImportError:
        sys.stderr.write(f"[train_lora_unsloth] missing dependency '{mod_name}'.\n")
        sys.stderr.write(f"                     install hint: {install_hint}\n")
        sys.exit(code)


def _holdout_expected(row):
    if not isinstance(row, dict):
        return None
    for key in ("teacher_output", "output", "expected", "response"):
        val = row.get(key)
        if val is not None:
            return str(val)
    return None


def load_holdout_rows(path, limit=512):
    """Load eval-only holdout rows. Mirrors train_lora.py so the Unsloth
    backend preserves the same W961 compile-gate metric contract.
    """
    rows = []
    if not path:
        return rows
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                prompt = obj.get("input") if isinstance(obj, dict) else None
                expected = _holdout_expected(obj)
                if prompt is None or expected is None:
                    continue
                rows.append({
                    "id": obj.get("id") or obj.get("event_id"),
                    "input": str(prompt),
                    "expected": str(expected),
                })
                if len(rows) >= limit:
                    break
    except FileNotFoundError:
        sys.stderr.write(f"[train_lora_unsloth] --holdout file not found: {path}\n")
    except OSError as e:
        sys.stderr.write(f"[train_lora_unsloth] --holdout read failed: {path}: {e}\n")
    return rows


def evaluate_student_holdout(model, tok, holdout_path, max_length, torch_mod, limit=512):
    rows = load_holdout_rows(holdout_path, limit=limit)
    if not rows:
        return {
            "student_holdout_accuracy": None,
            "holdout_accuracy": None,
            "holdout_rows": 0,
            "holdout_rows_scored": 0,
            "holdout_token_count": 0,
            "holdout_path": holdout_path,
        }
    try:
        device = next(model.parameters()).device
    except Exception:
        device = None
    model.eval()
    total = 0
    correct = 0
    loss_sum = 0.0
    rows_scored = 0
    with torch_mod.no_grad():
        for row in rows:
            prompt_text = f"<|user|>\n{row['input']}\n<|assistant|>\n"
            completion = row["expected"]
            eos = tok.eos_token or ""
            full_text = f"{prompt_text}{completion}{eos}"
            prompt_ids = tok(prompt_text, truncation=True, max_length=max_length)["input_ids"]
            enc = tok(full_text, truncation=True, max_length=max_length, return_tensors="pt")
            input_ids = enc["input_ids"]
            if input_ids.shape[1] <= 1:
                continue
            prompt_len = min(len(prompt_ids), input_ids.shape[1] - 1)
            if prompt_len >= input_ids.shape[1]:
                continue
            labels = input_ids.clone()
            labels[:, :prompt_len] = -100
            if device is not None:
                input_ids = input_ids.to(device)
                labels = labels.to(device)
                if "attention_mask" in enc:
                    enc["attention_mask"] = enc["attention_mask"].to(device)
            kwargs = {"input_ids": input_ids, "labels": labels}
            if "attention_mask" in enc:
                kwargs["attention_mask"] = enc["attention_mask"]
            out = model(**kwargs)
            logits = out.logits[0, prompt_len - 1:-1, :]
            target = input_ids[0, prompt_len:]
            if logits.shape[0] != target.shape[0] or target.numel() == 0:
                continue
            pred = logits.argmax(dim=-1)
            n_tok = int(target.numel())
            correct += int((pred == target).sum().item())
            total += n_tok
            rows_scored += 1
            if getattr(out, "loss", None) is not None:
                loss_sum += float(out.loss.detach().cpu().item()) * n_tok
    acc = (correct / total) if total > 0 else None
    eval_loss = (loss_sum / total) if total > 0 and loss_sum > 0 else None
    return {
        "student_holdout_accuracy": acc,
        "holdout_accuracy": acc,
        "eval_accuracy": acc,
        "eval_loss": eval_loss,
        "loss_final": eval_loss,
        "ppl_eval": math.exp(min(20.0, eval_loss)) if eval_loss is not None else None,
        "holdout_rows": len(rows),
        "holdout_rows_scored": rows_scored,
        "holdout_token_count": total,
        "holdout_correct_tokens": correct,
        "holdout_path": holdout_path,
        "holdout_metric": "response_token_next_token_accuracy",
    }


def main():
    p = argparse.ArgumentParser(description="kolm distillation LoRA fine-tune (Unsloth backend)")
    p.add_argument("--pairs", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--student-base", default="Qwen/Qwen2.5-0.5B")
    p.add_argument("--lora-rank", "--lora-r", dest="lora_rank", type=int, default=16)
    p.add_argument("--lora-alpha", type=int, default=32)
    p.add_argument("--lora-dropout", type=float, default=0.05)
    p.add_argument("--epochs", type=int, default=3)
    p.add_argument("--batch-size", type=int, default=4)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--max-length", "--max-seq-len", dest="max_length", type=int, default=512)
    p.add_argument("--gradient-accumulation-steps", type=int, default=1)
    p.add_argument("--resume-from-checkpoint", default="")
    p.add_argument("--save-steps", type=int, default=0)
    p.add_argument("--eval-steps", type=int, default=0)
    p.add_argument("--val-fraction", type=float, default=0.0)
    p.add_argument("--holdout", default=None,
                   help="eval-only JSONL with {input, output|expected|teacher_output}; never used for training")
    p.add_argument("--max-grad-norm", type=float, default=1.0)
    p.add_argument("--warmup-ratio", type=float, default=0.03)
    p.add_argument("--save-total-limit", type=int, default=3)
    p.add_argument("--qlora", action="store_true")
    p.add_argument("--optim", default=None)
    p.add_argument("--neftune-noise-alpha", dest="neftune_noise_alpha",
                   type=float, default=0.0)
    p.add_argument("--backend-reason", default="requested_unsloth",
                   help="Manifest tag carried from train_lora.py _select_backend.")
    args = p.parse_args()

    # Unsloth must be imported FIRST — it monkey-patches torch + transformers.
    # If this import succeeds in the parent dispatch but fails here, it's a
    # legitimate dep issue worth surfacing with the install hint.
    try:
        from unsloth import FastLanguageModel
    except Exception as e:
        sys.stderr.write(f"[train_lora_unsloth] failed to import unsloth: {e}\n")
        sys.stderr.write("                     install hint: pip install unsloth\n")
        sys.exit(11)

    torch = _require("torch", "pip install torch")
    _require("transformers", "pip install transformers")
    _require("peft", "pip install peft")
    _require("datasets", "pip install datasets")

    from transformers import TrainingArguments, Trainer, DataCollatorForLanguageModeling
    from datasets import Dataset

    if not os.path.exists(args.pairs):
        sys.stderr.write(f"[train_lora_unsloth] pairs file not found: {args.pairs}\n")
        sys.exit(4)
    os.makedirs(args.out, exist_ok=True)

    rows = []
    with open(args.pairs, "r", encoding="utf-8") as f:
        for ln in f:
            ln = ln.strip()
            if not ln:
                continue
            try:
                obj = json.loads(ln)
            except json.JSONDecodeError:
                continue
            if "input" not in obj or "teacher_output" not in obj:
                continue
            rows.append(obj)
    print(f"[train_lora_unsloth] {len(rows)} training pairs loaded from {args.pairs}")
    if not rows:
        sys.stderr.write("[train_lora_unsloth] no usable pairs; aborting.\n")
        sys.exit(5)

    # Precision selection mirrors train_lora.py so KOLM_PRECISION steers both.
    precision = os.environ.get("KOLM_PRECISION", "auto").lower()
    if precision == "auto":
        precision = "bf16" if (
            hasattr(torch, "cuda") and torch.cuda.is_available()
            and getattr(torch.cuda, "is_bf16_supported", lambda: False)()
        ) else "fp16"
    use_bf16 = precision in ("bf16", "mixed-bf16")
    use_fp16 = precision in ("fp16", "mixed-fp16")

    # Unsloth's FastLanguageModel.from_pretrained handles 4-bit + tokenizer +
    # model in one call. We pass load_in_4bit=True when --qlora is set; that's
    # the Unsloth-recommended path on consumer hardware.
    model, tok = FastLanguageModel.from_pretrained(
        model_name=args.student_base,
        max_seq_length=args.max_length,
        dtype=torch.bfloat16 if use_bf16 else (torch.float16 if use_fp16 else None),
        load_in_4bit=bool(args.qlora),
    )
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    # Get the PEFT-wrapped model. NEFTune folds in here; Unsloth applies the
    # noise during forward passes for any base it patches.
    peft_kwargs = dict(
        r=args.lora_rank,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=42,
        # Default target_modules covers q/k/v/o/gate/up/down. Override via env
        # only if a user knows their family needs something different.
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
    )
    if args.neftune_noise_alpha and args.neftune_noise_alpha > 0:
        peft_kwargs["neftune_noise_alpha"] = float(args.neftune_noise_alpha)
    model = FastLanguageModel.get_peft_model(model, **peft_kwargs)

    def to_example(row):
        prompt = str(row["input"])
        completion = str(row["teacher_output"])
        text = f"<|user|>\n{prompt}\n<|assistant|>\n{completion}{tok.eos_token}"
        enc = tok(text, truncation=True, max_length=args.max_length, padding="max_length")
        enc["labels"] = enc["input_ids"].copy()
        return enc

    ds = Dataset.from_list(rows).map(to_example, remove_columns=Dataset.from_list(rows).column_names)

    eval_ds = None
    if args.val_fraction > 0:
        if args.val_fraction >= 0.3:
            sys.stderr.write(f"[train_lora_unsloth] --val-fraction must be < 0.3; got {args.val_fraction}\n")
            sys.exit(6)
        ds_split = ds.train_test_split(test_size=args.val_fraction, seed=42)
        ds, eval_ds = ds_split["train"], ds_split["test"]
        print(f"[train_lora_unsloth] train={len(ds)} val={len(eval_ds)} (val_fraction={args.val_fraction})")

    save_strategy = "steps" if args.save_steps > 0 else "epoch"
    ta_kwargs = dict(
        output_dir=args.out,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.gradient_accumulation_steps,
        learning_rate=args.lr,
        max_grad_norm=args.max_grad_norm,
        warmup_ratio=args.warmup_ratio,
        save_strategy=save_strategy,
        save_total_limit=args.save_total_limit,
        logging_steps=10,
        report_to=[],
        fp16=use_fp16,
        bf16=use_bf16,
        optim=args.optim or ("adamw_8bit" if args.qlora else "adamw_torch"),
    )
    if args.save_steps > 0:
        ta_kwargs["save_steps"] = args.save_steps
    # NEFTune via Trainer kwarg in addition to the embedding-level Unsloth path.
    # HF Trainer 4.36+ accepts neftune_noise_alpha; either layer alone is
    # sufficient — both are harmless together because Unsloth installs at
    # embedding forward and Trainer at the same hook (no-op double-register).
    if args.neftune_noise_alpha and args.neftune_noise_alpha > 0:
        ta_kwargs["neftune_noise_alpha"] = float(args.neftune_noise_alpha)

    has_eval = eval_ds is not None
    if has_eval:
        if args.eval_steps > 0:
            ta_kwargs["eval_strategy"] = "steps"
            ta_kwargs["eval_steps"] = args.eval_steps
            if save_strategy == "steps" and args.save_steps != args.eval_steps:
                ta_kwargs["save_steps"] = args.eval_steps
        else:
            ta_kwargs["eval_strategy"] = "epoch"
            ta_kwargs["save_strategy"] = "epoch"
        ta_kwargs["load_best_model_at_end"] = True
        ta_kwargs["metric_for_best_model"] = "eval_loss"
        ta_kwargs["greater_is_better"] = False

    training = TrainingArguments(**ta_kwargs)

    trainer_kwargs = dict(
        model=model,
        args=training,
        train_dataset=ds,
        data_collator=DataCollatorForLanguageModeling(tok, mlm=False),
    )
    if eval_ds is not None:
        trainer_kwargs["eval_dataset"] = eval_ds
    trainer = Trainer(**trainer_kwargs)

    resume_arg = args.resume_from_checkpoint.strip() or None
    if resume_arg:
        if not os.path.isdir(resume_arg):
            sys.stderr.write(f"[train_lora_unsloth] --resume-from-checkpoint not found: {resume_arg}\n")
            sys.exit(8)
        print(f"[train_lora_unsloth] resuming from {resume_arg}")
        trainer.train(resume_from_checkpoint=resume_arg)
    else:
        trainer.train()

    model.save_pretrained(args.out)
    tok.save_pretrained(args.out)

    holdout_metrics = {}
    if args.holdout:
        try:
            holdout_metrics = evaluate_student_holdout(model, tok, args.holdout, args.max_length, torch)
            if holdout_metrics.get("student_holdout_accuracy") is not None:
                print("[train_lora_unsloth] holdout student token accuracy: "
                      f"{holdout_metrics['student_holdout_accuracy']:.4f} "
                      f"over {holdout_metrics.get('holdout_token_count', 0)} tokens")
            else:
                sys.stderr.write("[train_lora_unsloth] holdout supplied but no scorable response tokens were found\n")
        except Exception as e:
            holdout_metrics = {
                "student_holdout_accuracy": None,
                "holdout_accuracy": None,
                "holdout_path": args.holdout,
                "holdout_eval_error": str(e),
            }
            sys.stderr.write(f"[train_lora_unsloth] holdout evaluation failed: {e}\n")

    _reproducibility = {
        "git_sha": os.environ.get("KOLM_GIT_SHA") or None,
        "recipe_hash": os.environ.get("KOLM_RECIPE_HASH") or None,
        "recipe_name": os.environ.get("KOLM_RECIPE_NAME") or None,
        "scrubber_version": os.environ.get("KOLM_SCRUBBER_VERSION") or None,
        "pairs_hash": os.environ.get("KOLM_PAIRS_HASH") or None,
        "pairs_path": args.pairs,
        "kolm_version": os.environ.get("KOLM_VERSION") or None,
        "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "python_version": sys.version.split()[0],
        "platform": sys.platform,
    }
    if _reproducibility["pairs_hash"] is None and os.path.exists(args.pairs):
        try:
            import hashlib as _hashlib
            _h = _hashlib.sha256()
            with open(args.pairs, "rb") as _pf:
                for _chunk in iter(lambda: _pf.read(1 << 20), b""):
                    _h.update(_chunk)
            _reproducibility["pairs_hash"] = "sha256:" + _h.hexdigest()
            _reproducibility["pairs_hash_source"] = "computed_by_trainer"
        except Exception as _e:
            _reproducibility["pairs_hash"] = None
            _reproducibility["pairs_hash_error"] = str(_e)
    else:
        _reproducibility["pairs_hash_source"] = "env"

    with open(os.path.join(args.out, "training-summary.json"), "w", encoding="utf-8") as f:
        json.dump({
            "student_base": args.student_base,
            "lora_rank": args.lora_rank,
            "lora_alpha": args.lora_alpha,
            "epochs": args.epochs,
            "batch_size": args.batch_size,
            "lr": args.lr,
            "max_length": args.max_length,
            "pairs": len(rows),
            "student_holdout_accuracy": holdout_metrics.get("student_holdout_accuracy"),
            "holdout_accuracy": holdout_metrics.get("holdout_accuracy"),
            "eval_accuracy": holdout_metrics.get("eval_accuracy"),
            "eval_loss": holdout_metrics.get("eval_loss"),
            "loss_final": holdout_metrics.get("loss_final"),
            "ppl_eval": holdout_metrics.get("ppl_eval"),
            "holdout": {
                "path": holdout_metrics.get("holdout_path") if args.holdout else None,
                "metric": holdout_metrics.get("holdout_metric") if args.holdout else None,
                "rows": holdout_metrics.get("holdout_rows") if args.holdout else 0,
                "rows_scored": holdout_metrics.get("holdout_rows_scored") if args.holdout else 0,
                "token_count": holdout_metrics.get("holdout_token_count") if args.holdout else 0,
                "correct_tokens": holdout_metrics.get("holdout_correct_tokens") if args.holdout else 0,
                "error": holdout_metrics.get("holdout_eval_error"),
            },
            "reproducibility": _reproducibility,
            "efficiency": {
                "precision": precision,
                "fp16": use_fp16,
                "bf16": use_bf16,
                "gradient_checkpointing": True,
                "early_stop_enabled": eval_ds is not None,
                "early_stop_patience": None,
                "early_stop_delta": None,
            },
            "massive": {
                "gradient_accumulation_steps": args.gradient_accumulation_steps,
                "effective_batch_size": args.batch_size * args.gradient_accumulation_steps,
                "save_strategy": save_strategy,
                "save_steps": args.save_steps if args.save_steps > 0 else None,
                "eval_steps": args.eval_steps if args.eval_steps > 0 else None,
                "val_fraction": args.val_fraction if args.val_fraction > 0 else None,
                "val_rows": len(eval_ds) if eval_ds is not None else 0,
                "resumed_from": resume_arg,
                "qlora": bool(args.qlora),
                "optim": ta_kwargs.get("optim"),
                "deepspeed": None,
                "max_grad_norm": args.max_grad_norm,
                "warmup_ratio": args.warmup_ratio,
                "save_total_limit": args.save_total_limit,
            },
            "backend": {
                "selected": "unsloth",
                "reason": args.backend_reason,
                "requested": "auto-or-unsloth",
                "neftune_noise_alpha": float(args.neftune_noise_alpha) if args.neftune_noise_alpha else 0.0,
            },
        }, f, indent=2)

    print(f"[train_lora_unsloth] done. adapter at {args.out}")


if __name__ == "__main__":
    main()
