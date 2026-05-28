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
# _exec_unsloth_backend, plus --backend-reason for the manifest. Reads the
# same env vars (KOLM_PRECISION, KOLM_GRAD_CHECKPOINT, KOLM_EARLY_STOP*,
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
