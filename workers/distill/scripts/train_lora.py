#!/usr/bin/env python3
# workers/distill/scripts/train_lora.py
#
# LoRA fine-tune skeleton for the kolm distillation worker. Reads the
# training-pairs.jsonl produced by distill.mjs and fine-tunes a small
# open-weight base via PEFT/transformers/peft.
#
# This file intentionally fails fast and loud when torch/transformers/peft
# are missing — distill.mjs only invokes it after `--doctor` confirms the
# stack is present. The user-facing CLI never imports this file.
#
# Wave K (1216) will extend this with the quantization + GGUF/ONNX export
# step. Wave L (1217) will reuse the resulting student weights to emit a
# WASM target. This file is the shared training entry for both.

import argparse
import json
import sys
import os

# W921 — import the vendored LoRA-variant builder (same dir). Kept import-safe:
# lora_variants does NOT import torch/peft at module load.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import lora_variants as _lv  # noqa: E402
except Exception:  # pragma: no cover - worker stays usable if the file is absent
    _lv = None


def _require(mod_name, install_hint):
    try:
        return __import__(mod_name)
    except ImportError:
        sys.stderr.write(f"[train_lora] missing dependency '{mod_name}'.\n")
        sys.stderr.write(f"             install hint: {install_hint}\n")
        sys.exit(3)


def main():
    p = argparse.ArgumentParser(description="kolm distillation LoRA fine-tune")
    p.add_argument("--pairs", required=True, help="training-pairs.jsonl from distill.mjs")
    p.add_argument("--out", required=True, help="output directory for the student adapter")
    p.add_argument("--student-base", default="Qwen/Qwen2.5-0.5B", help="HF base model id")
    p.add_argument("--lora-rank", type=int, default=16)
    p.add_argument("--lora-alpha", type=int, default=32)
    p.add_argument("--epochs", type=int, default=3)
    p.add_argument("--batch-size", type=int, default=4)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--max-length", type=int, default=512)
    # W921 — dry-run / preflight: construct the variant config + probe deps and
    # exit WITHOUT loading models or training. GPU-free; used by --self-test and
    # the orchestrator preflight gate.
    p.add_argument("--preflight-only", action="store_true",
                   help="construct config + probe variant deps, then exit 0 (no training)")
    args = p.parse_args()

    # ── W921 LoRA-variant / GaLore / packing knobs (env-threaded, default-off) ──
    lora_variant = os.environ.get("KOLM_LORA_VARIANT", "lora").lower()
    lora_init = os.environ.get("KOLM_LORA_INIT", "default").lower()
    neftune_alpha = os.environ.get("KOLM_NEFTUNE_ALPHA")
    neftune_alpha = float(neftune_alpha) if neftune_alpha else None
    loraplus_ratio = float(os.environ.get("KOLM_LORAPLUS_RATIO", "16"))
    trainer_optim = os.environ.get("KOLM_OPTIM", "adamw_torch").lower()
    galore_args = os.environ.get("KOLM_GALORE_ARGS", "")
    galore_targets = os.environ.get("KOLM_GALORE_TARGETS", "attn,mlp")
    packing_enabled = os.environ.get("KOLM_PACKING", "0") == "1"
    variants_active = (lora_variant != "lora" or lora_init != "default" or neftune_alpha
                       or trainer_optim != "adamw_torch" or packing_enabled)

    # ── W921 preflight: probe variant deps; FAIL LOUD on missing support. ──
    if variants_active and _lv is not None:
        pf = _lv.preflight_variant_support(lora_init, trainer_optim)
        if not pf["ok"]:
            sys.stderr.write("[train_lora] variant preflight FAILED:\n")
            for h in pf["hints"]:
                sys.stderr.write(f"             - {h}\n")
            if args.preflight_only:
                print(json.dumps({"preflight": pf, "ok": False}))
            sys.exit(7)
    if args.preflight_only:
        # Construct the variant config WITHOUT loading models. Proves the path.
        cfg_preview = {
            "lora_variant": lora_variant,
            "lora_init": lora_init,
            "neftune_alpha": neftune_alpha,
            "optim": trainer_optim,
            "packing": packing_enabled,
            "galore_args": galore_args if trainer_optim.startswith("galore") else None,
        }
        print(json.dumps({"preflight": "ok", "config": cfg_preview, "ok": True}))
        sys.exit(0)

    # Hard dependency check — give the operator a single-line install hint
    # instead of a Python traceback.
    torch = _require("torch", "pip install torch")
    transformers = _require("transformers", "pip install transformers")  # noqa: F841 — availability probe; raises early w/ install hint
    peft = _require("peft", "pip install peft")  # noqa: F841 — availability probe; raises early w/ install hint
    datasets_mod = _require("datasets", "pip install datasets")  # noqa: F841 — availability probe; raises early w/ install hint
    _require("accelerate", "pip install accelerate")

    from transformers import (AutoModelForCausalLM, AutoTokenizer,
                              TrainingArguments, Trainer,
                              DataCollatorForLanguageModeling)
    from peft import LoraConfig, get_peft_model, TaskType
    from datasets import Dataset

    if not os.path.exists(args.pairs):
        sys.stderr.write(f"[train_lora] pairs file not found: {args.pairs}\n")
        sys.exit(4)

    os.makedirs(args.out, exist_ok=True)

    # Read JSONL pairs.
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
    print(f"[train_lora] {len(rows)} training pairs loaded from {args.pairs}")
    if not rows:
        sys.stderr.write("[train_lora] no usable pairs; aborting.\n")
        sys.exit(5)

    tok = AutoTokenizer.from_pretrained(args.student_base)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    def to_example(row):
        prompt = str(row["input"])
        completion = str(row["teacher_output"])
        # Simple instruction format. Real workloads will want a model-
        # specific template; this is the floor.
        text = f"<|user|>\n{prompt}\n<|assistant|>\n{completion}{tok.eos_token}"
        enc = tok(text, truncation=True, max_length=args.max_length, padding="max_length")
        enc["labels"] = enc["input_ids"].copy()
        return enc

    ds = Dataset.from_list(rows).map(to_example, remove_columns=Dataset.from_list(rows).column_names)

    base = AutoModelForCausalLM.from_pretrained(
        args.student_base,
        torch_dtype=torch.float16,
        device_map="auto",
    )

    # W921 — variant-aware LoRA config. When no variant knobs are set this
    # produces the IDENTICAL plain LoRA config as before (backward-compat).
    pissa_init_path = None
    if variants_active and _lv is not None:
        lvcfg = _lv.LoraVariantConfig(
            r=args.lora_rank,
            lora_alpha=args.lora_alpha,
            lora_dropout=0.05,
            bias="none",
            task_type="CAUSAL_LM",
            init_lora_weights=lora_init,
        ).variant_from_name(lora_variant)
        lora_cfg = _lv.build_peft_lora_config(lvcfg)
        model = get_peft_model(base, lora_cfg)
        # PiSSA: snapshot the untrained decomposition BEFORE training so the
        # adapter can be converted back to base-relative form at save.
        if lora_init in _lv.PISSA_INITS:
            try:
                pissa_init_path = _lv.snapshot_pissa_init(model, args.out)
            except Exception as e:
                sys.stderr.write(f"[train_lora] PiSSA snapshot failed: {e}\n")
    else:
        lvcfg = None
        lora_cfg = LoraConfig(
            r=args.lora_rank,
            lora_alpha=args.lora_alpha,
            task_type=TaskType.CAUSAL_LM,
            bias="none",
            lora_dropout=0.05,
        )
        model = get_peft_model(base, lora_cfg)
    model.print_trainable_parameters()

    # W787 — read compute-efficiency knobs from env so the Node-side
    # `kolm distill --precision/--gradient-checkpointing/--early-stop-patience`
    # flags actually steer the trainer instead of being marketing copy.
    # Default precision = bf16 when supported, fp16 fallback otherwise
    # (matches the trainer_real.py auto-detect convention).
    precision = os.environ.get("KOLM_PRECISION", "auto").lower()
    if precision == "auto":
        precision = "bf16" if hasattr(torch, "cuda") and torch.cuda.is_available() and getattr(torch.cuda, "is_bf16_supported", lambda: False)() else "fp16"
    fp16_flag = precision in ("fp16", "mixed-fp16")
    bf16_flag = precision in ("bf16", "mixed-bf16")
    if precision == "fp32":
        fp16_flag = False
        bf16_flag = False
    grad_ckpt_flag = os.environ.get("KOLM_GRAD_CHECKPOINT", "0") == "1"
    ta_kwargs = dict(
        output_dir=args.out,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        learning_rate=args.lr,
        save_strategy="epoch",
        logging_steps=10,
        report_to=[],
        fp16=fp16_flag,
        bf16=bf16_flag,
        gradient_checkpointing=grad_ckpt_flag,
    )
    if grad_ckpt_flag:
        ta_kwargs["gradient_checkpointing_kwargs"] = {"use_reentrant": False}
    # W787-1 — early-stop knobs. transformers's EarlyStoppingCallback needs
    # eval steps; when the operator opts in we switch to per-epoch eval +
    # load_best_model_at_end so the callback has something to compare.
    early_stop_enabled = os.environ.get("KOLM_EARLY_STOP", "0") == "1"
    if early_stop_enabled:
        ta_kwargs["evaluation_strategy"] = "epoch"
        ta_kwargs["load_best_model_at_end"] = True
        ta_kwargs["metric_for_best_model"] = "eval_loss"
        ta_kwargs["greater_is_better"] = False
    # W921 — NEFTune is a TrainingArguments field. GaLore is wired via the
    # optim/optim_target_modules/optim_args TrainingArguments fields (the
    # builder also enforces the incompatible-combo refusals).
    if neftune_alpha:
        ta_kwargs["neftune_noise_alpha"] = float(neftune_alpha)
    custom_optimizer = None
    if variants_active and _lv is not None and trainer_optim.startswith("galore"):
        try:
            training = _lv.build_galore_training_args(
                ta_kwargs,
                optim=trainer_optim,
                target_modules=[m.strip() for m in galore_targets.split(",") if m.strip()],
                optim_args=galore_args,
            )
        except Exception as e:
            sys.stderr.write(f"[train_lora] GaLore setup refused: {e}\n")
            sys.exit(8)
    else:
        training = TrainingArguments(**ta_kwargs)
        # LoRA+ / LoRA-FA need a hand-built optimizer (param-group split / freeze).
        if variants_active and _lv is not None and lvcfg is not None and (lvcfg.use_lora_plus or lvcfg.freeze_a):
            try:
                custom_optimizer = _lv.build_optimizer(
                    model, lvcfg, base_lr=args.lr,
                    paged_8bit=trainer_optim in ("adamw_8bit", "paged_adamw_8bit"),
                )
            except Exception as e:
                sys.stderr.write(f"[train_lora] custom optimizer build failed: {e}\n")

    callbacks = []
    if early_stop_enabled:
        # W787-1 — EarlyStoppingCallback. patience = KOLM_EARLY_STOP_PATIENCE
        # (default 3) maps to the transformers `early_stopping_patience`
        # semantic (number of eval rounds with no improvement). delta maps
        # to early_stopping_threshold.
        try:
            from transformers import EarlyStoppingCallback
            patience = int(os.environ.get("KOLM_EARLY_STOP_PATIENCE", "3"))
            delta = float(os.environ.get("KOLM_EARLY_STOP_DELTA", "0.005"))
            callbacks.append(EarlyStoppingCallback(
                early_stopping_patience=patience,
                early_stopping_threshold=delta,
            ))
        except Exception as e:
            sys.stderr.write(f"[train_lora] KOLM_EARLY_STOP=1 but EarlyStoppingCallback unavailable: {e}\n")

    trainer_kwargs = dict(
        model=model,
        args=training,
        train_dataset=ds,
        data_collator=DataCollatorForLanguageModeling(tok, mlm=False),
        callbacks=callbacks,
    )
    # W921 — inject the hand-built optimizer for LoRA+/LoRA-FA (scheduler left
    # to the Trainer default by passing (optim, None)).
    if custom_optimizer is not None:
        trainer_kwargs["optimizers"] = (custom_optimizer, None)
    trainer = Trainer(**trainer_kwargs)

    trainer.train()
    # W921 — PiSSA conversion at save: rewrite the residual-relative adapter to
    # standard-base form so it loads on the ORIGINAL published base.
    pissa_converted = False
    if pissa_init_path and _lv is not None:
        conv = _lv.convert_pissa_save(model, args.out, pissa_init_path)
        pissa_converted = bool(conv.get("pissa_converted"))
    else:
        model.save_pretrained(args.out)
    tok.save_pretrained(args.out)

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
            # W787 — record the effective compute-efficiency choices so the
            # downstream .kolm receipt chain documents which precision + grad-
            # checkpoint + early-stop config trained this adapter.
            "efficiency": {
                "precision": precision,
                "fp16": fp16_flag,
                "bf16": bf16_flag,
                "gradient_checkpointing": grad_ckpt_flag,
                "early_stop_enabled": early_stop_enabled,
                "early_stop_patience": int(os.environ.get("KOLM_EARLY_STOP_PATIENCE", "3")) if early_stop_enabled else None,
                "early_stop_delta": float(os.environ.get("KOLM_EARLY_STOP_DELTA", "0.005")) if early_stop_enabled else None,
            },
            # W921 — LoRA-variant / optimizer / packing provenance so the .kolm
            # receipt chain documents the REAL training objective. Defaults
            # record the vanilla path; pissa_converted proves a PiSSA adapter is
            # base-relative (loads on the published base).
            "variants": {
                "lora_variant": lora_variant,
                "lora_init": lora_init,
                "neftune_alpha": neftune_alpha,
                "loraplus_ratio": loraplus_ratio if lora_variant == "loraplus" else None,
                "optim": trainer_optim,
                "galore_args": galore_args if trainer_optim.startswith("galore") else None,
                "packing": packing_enabled,
                "pissa_converted": pissa_converted,
            },
        }, f, indent=2)

    print(f"[train_lora] done. adapter at {args.out}")


if __name__ == "__main__":
    main()
