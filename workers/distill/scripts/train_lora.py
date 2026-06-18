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
import importlib.util
import json
import math
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


UNSLOTH_FAMILIES = (
    "qwen",
    "qwen2",
    "qwen3",
    "llama",
    "llama-2",
    "llama-3",
    "gemma",
    "gemma2",
    "gemma3",
    "mistral",
    "phi",
    "deepseek",
    "gpt-oss",
)

_MODEL_ALIASES = {
    "qwen2.5-0.5b": "Qwen/Qwen2.5-0.5B-Instruct",
    "qwen2.5-0.5b-instruct": "Qwen/Qwen2.5-0.5B-Instruct",
    "qwen2.5-1.5b": "Qwen/Qwen2.5-1.5B-Instruct",
    "qwen2.5-3b": "Qwen/Qwen2.5-3B-Instruct",
    "llama-3.2-1b": "meta-llama/Llama-3.2-1B-Instruct",
    "llama-3.2-3b": "meta-llama/Llama-3.2-3B-Instruct",
}


def _resolve_student_base_alias(student_base):
    return _MODEL_ALIASES.get(str(student_base).lower(), student_base)


def _unsloth_importable():
    try:
        return importlib.util.find_spec("unsloth") is not None
    except Exception:
        return False


def _is_unsloth_supported(student_base):
    base = str(student_base or "").strip().lower()
    if not base:
        return False
    return any(family in base for family in UNSLOTH_FAMILIES)


LIGER_KERNEL_APIS = (
    ("qwen3.5_moe", "apply_liger_kernel_to_qwen3_5_moe", ("qwen3.5-moe", "qwen3_5_moe", "qwen3.5moe")),
    ("qwen3.5", "apply_liger_kernel_to_qwen3_5", ("qwen3.5", "qwen3_5")),
    ("qwen3_moe", "apply_liger_kernel_to_qwen3_moe", ("qwen3-moe", "qwen3_moe", "qwen3moe")),
    ("qwen3", "apply_liger_kernel_to_qwen3", ("qwen3",)),
    ("qwen2.5_vl", "apply_liger_kernel_to_qwen2_5_vl", ("qwen2.5-vl", "qwen2_5_vl")),
    ("qwen2_vl", "apply_liger_kernel_to_qwen2_vl", ("qwen2-vl", "qwen2_vl", "qvq")),
    ("qwen2", "apply_liger_kernel_to_qwen2", ("qwen2", "qwq")),
    ("llama4", "apply_liger_kernel_to_llama4", ("llama-4", "llama4")),
    ("llama", "apply_liger_kernel_to_llama", ("llama", "codellama")),
    ("ministral", "apply_liger_kernel_to_ministral", ("ministral",)),
    ("mistral", "apply_liger_kernel_to_mistral", ("mistral",)),
    ("mixtral", "apply_liger_kernel_to_mixtral", ("mixtral",)),
    ("gemma4", "apply_liger_kernel_to_gemma4_text", ("gemma-4", "gemma4")),
    ("gemma3", "apply_liger_kernel_to_gemma3_text", ("gemma-3", "gemma3")),
    ("gemma2", "apply_liger_kernel_to_gemma2", ("gemma-2", "gemma2")),
    ("gemma", "apply_liger_kernel_to_gemma", ("gemma",)),
    ("phi3", "apply_liger_kernel_to_phi3", ("phi-3", "phi3", "phi-3.5", "phi3.5")),
    ("granite", "apply_liger_kernel_to_granite", ("granite",)),
    ("olmo3", "apply_liger_kernel_to_olmo3", ("olmo-3", "olmo3")),
    ("olmo2", "apply_liger_kernel_to_olmo2", ("olmo-2", "olmo2")),
    ("glm4", "apply_liger_kernel_to_glm4", ("glm-4", "glm4")),
    ("deepseek_v4", "apply_liger_kernel_to_deepseek_v4", ("deepseek-v4", "deepseek_v4")),
    ("gpt_oss", "apply_liger_kernel_to_gpt_oss", ("gpt-oss", "gpt_oss")),
    ("hunyuan_v1_moe", "apply_liger_kernel_to_hunyuan_v1_moe", ("hunyuan-v1-moe", "hunyuan_v1_moe")),
    ("hunyuan_v1_dense", "apply_liger_kernel_to_hunyuan_v1_dense", ("hunyuan-v1", "hunyuan_v1")),
)


def _liger_mode():
    raw = str(os.environ.get("KOLM_USE_LIGER", "") or "").strip().lower()
    requested = raw in ("1", "true", "yes", "on", "required", "require", "strict")
    required = raw in ("required", "require", "strict")
    return raw, requested, required


def _liger_api_for_model(student_base):
    slug = str(student_base or "").strip().lower().replace("/", "-")
    for family, api_name, needles in LIGER_KERNEL_APIS:
        if any(needle in slug for needle in needles):
            return family, api_name
    return None, None


def _fail_liger_required(plan):
    sys.stderr.write("[train_lora] KOLM_USE_LIGER strict/required failed: "
                     + str(plan.get("skipped_reason") or plan.get("error") or "unknown") + "\n")
    if plan.get("install_hint"):
        sys.stderr.write(f"             install hint: {plan['install_hint']}\n")
    sys.exit(14)


def _maybe_apply_liger(student_base, apply_patch=False):
    mode, requested, required = _liger_mode()
    family, api_name = _liger_api_for_model(student_base)
    plan = {
        "requested": requested,
        "required": required,
        "mode": mode or "off",
        "model_family": family,
        "api": api_name,
        "available": False,
        "would_apply": False,
        "applied": False,
        "skipped_reason": "disabled" if not requested else None,
        "install_hint": "pip install liger-kernel",
    }
    if not requested:
        return plan
    if not api_name:
        plan["skipped_reason"] = "unsupported_model_family"
        if required:
            _fail_liger_required(plan)
        return plan
    try:
        liger_transformers = importlib.import_module("liger_kernel.transformers")
    except ImportError:
        plan["skipped_reason"] = "liger_kernel_not_installed"
        if required:
            _fail_liger_required(plan)
        sys.stderr.write("[train_lora] KOLM_USE_LIGER set but liger-kernel not installed; skipping\n")
        return plan
    patch_fn = getattr(liger_transformers, api_name, None)
    if not callable(patch_fn):
        plan["skipped_reason"] = "liger_api_unavailable"
        if required:
            _fail_liger_required(plan)
        sys.stderr.write(f"[train_lora] liger-kernel installed but {api_name} is unavailable; skipping\n")
        return plan
    plan["available"] = True
    plan["would_apply"] = True
    plan["skipped_reason"] = None
    if apply_patch:
        try:
            patch_fn()
            plan["applied"] = True
            print(f"[train_lora] Liger Kernel applied via {api_name} for {student_base}")
        except Exception as e:
            plan["error"] = str(e)
            plan["skipped_reason"] = "liger_patch_failed"
            plan["would_apply"] = False
            if required:
                _fail_liger_required(plan)
            sys.stderr.write(f"[train_lora] Liger Kernel patch failed ({e}); continuing without it\n")
    return plan


def _select_backend(requested, student_base):
    backend = str(requested or "auto").strip().lower()
    if backend == "hf":
        return ("hf", "requested_hf")
    if backend == "auto":
        if not _is_unsloth_supported(student_base):
            return ("hf", "auto_family_unsupported")
        if _unsloth_importable():
            return ("unsloth", "auto_family_match")
        return ("hf", "auto_family_match_but_unsloth_not_installed")
    if backend == "unsloth":
        if not _unsloth_importable():
            sys.stderr.write("[train_lora] missing dependency 'unsloth'.\n")
            sys.stderr.write("             install hint: pip install unsloth\n")
            sys.exit(11)
        return ("unsloth", "requested_unsloth")
    raise ValueError(f"unknown backend: {requested}")


def _backend_hf_only_features(args, lora_variant, lora_init, trainer_optim, packing_enabled):
    features = []
    curriculum_requested = bool(args.curriculum) and str(args.curriculum).lower() not in ("0", "false", "off", "")
    if curriculum_requested:
        features.append("curriculum")
    if args.importance_weights:
        features.append("importance_weights")
    if lora_variant != "lora":
        features.append(f"lora_variant:{lora_variant}")
    if lora_init != "default":
        features.append(f"lora_init:{lora_init}")
    if trainer_optim.startswith("galore"):
        features.append(f"optim:{trainer_optim}")
    if packing_enabled:
        features.append("packing")
    return features


def _backend_plan_for_args(args, lora_variant, lora_init, trainer_optim, packing_enabled):
    selected, reason = _select_backend(args.backend, args.student_base)
    hf_only = _backend_hf_only_features(args, lora_variant, lora_init, trainer_optim, packing_enabled)
    if selected == "unsloth" and hf_only:
        if str(args.backend).lower() == "unsloth":
            sys.stderr.write("[train_lora] --backend=unsloth cannot preserve these HF-only features: "
                             + ", ".join(hf_only) + "\n")
            sys.stderr.write("             use --backend=hf or remove those knobs.\n")
            sys.exit(12)
        selected = "hf"
        reason = "auto_hf_feature_parity_guard"
    return {
        "selected": selected,
        "reason": reason,
        "requested": str(args.backend or "auto").lower(),
        "unsloth_importable": _unsloth_importable(),
        "unsloth_supported": _is_unsloth_supported(args.student_base),
        "unsloth_families": list(UNSLOTH_FAMILIES),
        "hf_only_features": hf_only,
    }


def _exec_unsloth_backend(args, backend_reason, neftune_alpha, trainer_optim):
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "train_lora_unsloth.py")
    if not os.path.exists(script):
        sys.stderr.write(f"[train_lora] expected Unsloth backend mirror not found: {script}\n")
        sys.exit(11)
    argv = [
        sys.executable,
        script,
        "--pairs", args.pairs,
        "--out", args.out,
        "--student-base", args.student_base,
        "--lora-rank", str(args.lora_rank),
        "--lora-alpha", str(args.lora_alpha),
        "--lora-dropout", str(args.lora_dropout),
        "--epochs", str(args.epochs),
        "--batch-size", str(args.batch_size),
        "--lr", str(args.lr),
        "--max-length", str(args.max_length),
        "--gradient-accumulation-steps", str(args.gradient_accumulation_steps),
        "--max-grad-norm", str(args.max_grad_norm),
        "--warmup-ratio", str(args.warmup_ratio),
        "--save-total-limit", str(args.save_total_limit),
        "--backend-reason", backend_reason,
    ]
    if args.resume_from_checkpoint:
        argv.extend(["--resume-from-checkpoint", args.resume_from_checkpoint])
    if args.save_steps and args.save_steps > 0:
        argv.extend(["--save-steps", str(args.save_steps)])
    if args.eval_steps and args.eval_steps > 0:
        argv.extend(["--eval-steps", str(args.eval_steps)])
    if args.val_fraction and args.val_fraction > 0:
        argv.extend(["--val-fraction", str(args.val_fraction)])
    if args.qlora:
        argv.append("--qlora")
    if trainer_optim and trainer_optim != "adamw_torch":
        argv.extend(["--optim", trainer_optim])
    if neftune_alpha:
        argv.extend(["--neftune-noise-alpha", str(neftune_alpha)])
    os.execv(sys.executable, argv)


def _row_id(row):
    """Stable id for a pair row, matching the JS capture_id contract."""
    for k in ("id", "capture_id", "event_id", "trace_id"):
        v = row.get(k) if isinstance(row, dict) else None
        if isinstance(v, str) and v:
            return v
    return None


def curriculum_sort_rows(rows, mode):
    """Sort rows ascending (default) / descending by complexity_proxy. Rows
    missing the field get a neutral 0.5 so the sort stays well-defined. STABLE
    (Python sort is stable) so equal-complexity rows keep input order. Returns
    (sorted_rows, meta). Mirrors apps/trainer/distill.py::_curriculum_sort_rows."""
    direction = "descending" if str(mode).lower() == "descending" else "ascending"
    n_missing = 0

    def _key(r):
        nonlocal n_missing
        cp = r.get("complexity_proxy") if isinstance(r, dict) else None
        if not isinstance(cp, (int, float)):
            n_missing += 1
            return 0.5
        return max(0.0, min(1.0, float(cp)))

    keyed = [(_key(r), i, r) for i, r in enumerate(rows)]
    reverse = direction == "descending"
    keyed.sort(key=lambda t: (t[0], t[1]), reverse=reverse)
    # reverse=True also flips the stable index tiebreak; re-stabilize.
    if reverse:
        keyed.sort(key=lambda t: t[1])
        keyed.sort(key=lambda t: -t[0])
    out = [t[2] for t in keyed]
    return out, {"mode": direction, "rows": len(rows), "rows_missing_proxy": n_missing}


def load_importance_weights(path):
    """Load a {capture_id, importance} JSONL into a dict. Malformed rows are
    skipped (never aborts). Mirrors apps/trainer/distill.py::
    _load_importance_weights_jsonl."""
    weights = {}
    if not path:
        return weights
    try:
        with open(path, "r", encoding="utf-8") as f:
            for ln, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                cid = obj.get("capture_id")
                imp = obj.get("importance")
                if not isinstance(cid, str) or not isinstance(imp, (int, float)):
                    continue
                weights[cid] = max(0.0, min(1.0, float(imp)))
    except FileNotFoundError:
        sys.stderr.write(f"[train_lora] --importance-weights file not found: {path}\n")
        return {}
    except OSError as e:
        sys.stderr.write(f"[train_lora] --importance-weights read failed: {path}: {e}\n")
        return {}
    return weights


def build_weighted_sampler(rows, weights):
    """Map per-row importance to a torch WeightedRandomSampler. Returns
    (sampler, n_matched). Unmatched rows get a neutral 0.5 weight so they stay
    in the sample. Returns (None, 0) when nothing matched (caller falls back to
    default sampling). Mirrors apps/trainer/distill.py::_build_weighted_sampler."""
    import torch
    from torch.utils.data import WeightedRandomSampler

    if not weights or not rows:
        return None, 0
    per_row = []
    matched = 0
    for r in rows:
        cid = _row_id(r)
        if cid and cid in weights:
            per_row.append(float(weights[cid]))
            matched += 1
        else:
            per_row.append(0.5)
    if matched == 0:
        return None, 0
    if sum(per_row) <= 0:
        per_row = [1e-6 for _ in per_row]
    w = torch.as_tensor(per_row, dtype=torch.double)
    return WeightedRandomSampler(weights=w, num_samples=len(per_row), replacement=True), matched


def _holdout_expected(row):
    if not isinstance(row, dict):
        return None
    for key in ("teacher_output", "output", "expected", "response"):
        val = row.get(key)
        if val is not None:
            return str(val)
    return None


def load_holdout_rows(path, limit=512):
    """Load eval-only holdout rows. Accepts the worker's {input, output}
    seeds rows and the trainer's {input, teacher_output} training-pair rows.
    Malformed rows are skipped; absence returns [] so the caller can keep the
    trained adapter while the compile gate refuses missing metrics later.
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
        sys.stderr.write(f"[train_lora] --holdout file not found: {path}\n")
    except OSError as e:
        sys.stderr.write(f"[train_lora] --holdout read failed: {path}: {e}\n")
    return rows


def evaluate_student_holdout(model, tok, holdout_path, max_length, torch_mod, limit=512):
    """Measure student next-token accuracy on response tokens only.

    The prompt format mirrors to_example() below, but the held-out rows are not
    part of the Trainer train_dataset. This produces the student_holdout_accuracy
    that W960's compile gate requires before signing a distilled_model artifact.
    """
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
    p = argparse.ArgumentParser(description="kolm distillation LoRA fine-tune")
    p.add_argument("--pairs", required=False, help="training-pairs.jsonl from distill.mjs")
    p.add_argument("--out", required=False, help="output directory for the student adapter")
    p.add_argument("--student-base", default="Qwen/Qwen2.5-0.5B", help="HF base model id")
    p.add_argument("--backend", choices=("auto", "hf", "unsloth"),
                   default=os.environ.get("KOLM_TRAIN_LORA_BACKEND", "auto"),
                   help="trainer backend: auto uses Unsloth when supported+installed, hf forces the legacy path")
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
    p.add_argument("--qlora", action="store_true",
                   help="use the Unsloth QLoRA path; HF fallback refuses rather than silently running plain LoRA")
    p.add_argument("--neftune-noise-alpha", dest="neftune_noise_alpha", type=float, default=None)
    # W713 — curriculum ordering. When set (ascending|descending|1), sort the
    # training rows by their complexity_proxy field (stamped JS-side by
    # src/curriculum-sort.js + carried through distill.mjs) and walk them with a
    # SequentialSampler so the student sees the easy distribution first. A
    # shuffler / WeightedRandomSampler defeats the order, so --curriculum WINS
    # over --importance-weights when both are passed.
    p.add_argument("--curriculum", default=None,
                   help="ascending|descending|1 — order rows by complexity_proxy")
    # W711 — importance weighting. When set to a weights JSONL ({capture_id,
    # importance}), oversample high-value captures via a WeightedRandomSampler.
    p.add_argument("--importance-weights", dest="importance_weights", default=None,
                   help="path to {capture_id, importance} JSONL for weighted sampling")
    # W921 — dry-run / preflight: construct the variant config + probe deps and
    # exit WITHOUT loading models or training. GPU-free; used by --self-test and
    # the orchestrator preflight gate.
    p.add_argument("--preflight-only", action="store_true",
                   help="construct config + probe variant deps, then exit 0 (no training)")
    args = p.parse_args()
    requested_student_base = args.student_base
    args.student_base = _resolve_student_base_alias(args.student_base)

    # ── W921 LoRA-variant / GaLore / packing knobs (env-threaded, default-off) ──
    lora_variant = os.environ.get("KOLM_LORA_VARIANT", "rslora").lower()
    lora_init = os.environ.get("KOLM_LORA_INIT", "default").lower()
    neftune_alpha = args.neftune_noise_alpha
    if neftune_alpha is None:
        neftune_alpha = os.environ.get("KOLM_NEFTUNE_ALPHA")
        neftune_alpha = float(neftune_alpha) if neftune_alpha else None
    loraplus_ratio = float(os.environ.get("KOLM_LORAPLUS_RATIO", "16"))
    trainer_optim = os.environ.get("KOLM_OPTIM", "adamw_torch").lower()
    galore_args = os.environ.get("KOLM_GALORE_ARGS", "")
    galore_targets = os.environ.get("KOLM_GALORE_TARGETS", "attn,mlp")
    packing_enabled = os.environ.get("KOLM_PACKING", "0") == "1"
    variants_active = (lora_variant != "lora" or lora_init != "default" or neftune_alpha
                       or trainer_optim != "adamw_torch" or packing_enabled)
    backend_plan = _backend_plan_for_args(args, lora_variant, lora_init, trainer_optim, packing_enabled)
    liger_plan = _maybe_apply_liger(args.student_base, apply_patch=False)

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
            "student_base": args.student_base,
            "student_base_requested": requested_student_base,
            "liger": liger_plan,
        }
        print(json.dumps({
            "preflight": "ok",
            "config": cfg_preview,
            "backend": backend_plan,
            "checks": {
                "unsloth_importable": backend_plan["unsloth_importable"],
                "unsloth_supported": backend_plan["unsloth_supported"],
                "unsloth_families": backend_plan["unsloth_families"],
                "unsloth_skip_reason": None if backend_plan["selected"] == "unsloth" else backend_plan["reason"],
                "liger_available": liger_plan["available"],
                "liger_api": liger_plan["api"],
            },
            "ok": True,
        }))
        sys.exit(0)

    if not args.pairs:
        p.error("--pairs is required unless --preflight-only")
    if not args.out:
        p.error("--out is required unless --preflight-only")
    if args.student_base != requested_student_base:
        print(f"[train_lora] resolved student base '{requested_student_base}' -> '{args.student_base}'")
    if args.qlora and backend_plan["selected"] != "unsloth":
        sys.stderr.write("[train_lora] --qlora requires the Unsloth backend in this worker.\n")
        sys.stderr.write(f"             selected backend={backend_plan['selected']} reason={backend_plan['reason']}\n")
        sys.stderr.write("             install unsloth or remove --qlora for plain HF LoRA.\n")
        sys.exit(13)
    if backend_plan["selected"] == "unsloth":
        _exec_unsloth_backend(args, backend_plan["reason"], neftune_alpha, trainer_optim)

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

    # ── W713/W711 data-ordering resolution. --curriculum WINS over
    # --importance-weights (deterministic curriculum order is incompatible with
    # weighted random sampling). We record what actually engaged in
    # ordering_meta so the training-summary documents it. ──
    ordering_meta = {"curriculum": None, "importance_weights": False}
    curriculum_active = bool(args.curriculum) and str(args.curriculum).lower() not in ("0", "false", "off", "")
    if curriculum_active:
        rows, cmeta = curriculum_sort_rows(rows, args.curriculum)
        ordering_meta["curriculum"] = cmeta
        print(f"[train_lora] curriculum sort active ({cmeta['mode']}); "
              f"{cmeta['rows_missing_proxy']}/{cmeta['rows']} rows lacked complexity_proxy (neutral 0.5)")
    importance_weights = {}
    if args.importance_weights and not curriculum_active:
        importance_weights = load_importance_weights(args.importance_weights)
        if importance_weights:
            print(f"[train_lora] importance weighting active: {len(importance_weights)} weights loaded")
    elif args.importance_weights and curriculum_active:
        sys.stderr.write("[train_lora] --curriculum set; ignoring --importance-weights "
                         "(curriculum order wins over weighted sampling)\n")

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
    eval_ds = None
    if args.val_fraction > 0:
        if args.val_fraction >= 0.3:
            sys.stderr.write(f"[train_lora] --val-fraction must be < 0.3; got {args.val_fraction}\n")
            sys.exit(6)
        ds_split = ds.train_test_split(test_size=args.val_fraction, seed=42)
        ds, eval_ds = ds_split["train"], ds_split["test"]
        print(f"[train_lora] train={len(ds)} val={len(eval_ds)} (val_fraction={args.val_fraction})")

    liger_plan = _maybe_apply_liger(args.student_base, apply_patch=True)
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
            lora_dropout=args.lora_dropout,
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
            lora_dropout=args.lora_dropout,
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
        fp16=fp16_flag,
        bf16=bf16_flag,
        gradient_checkpointing=grad_ckpt_flag,
    )
    if args.save_steps > 0:
        ta_kwargs["save_steps"] = args.save_steps
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
    if eval_ds is not None:
        if args.eval_steps > 0:
            ta_kwargs["evaluation_strategy"] = "steps"
            ta_kwargs["eval_steps"] = args.eval_steps
            if save_strategy == "steps" and args.save_steps != args.eval_steps:
                ta_kwargs["save_steps"] = args.eval_steps
        else:
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

    # ── W713/W711 — sampler override. We subclass Trainer to install either a
    # SequentialSampler (curriculum: walk the pre-ordered rows in order) or a
    # WeightedRandomSampler (importance: oversample high-value captures). Rows
    # in `ds` are index-aligned to `rows`, so the weighted sampler built from
    # `rows` maps cleanly onto the dataset. When neither is active the override
    # returns None so the stock Trainer sampler (shuffle) is used unchanged. ──
    from torch.utils.data import SequentialSampler
    _curriculum_active = curriculum_active
    _weighted_sampler = None
    _weighted_matched = 0
    if importance_weights:
        _weighted_sampler, _weighted_matched = build_weighted_sampler(rows, importance_weights)
        if _weighted_sampler is not None:
            ordering_meta["importance_weights"] = {
                "weights_loaded": len(importance_weights),
                "rows_matched": _weighted_matched,
                "rows_total": len(rows),
            }
        else:
            sys.stderr.write("[train_lora] no rows matched the importance weights; "
                             "falling back to default sampling\n")

    class _KolmOrderedTrainer(Trainer):
        def _get_train_sampler(self, *a, **k):
            if _curriculum_active:
                # Deterministic simple->complex walk over the pre-ordered rows.
                return SequentialSampler(self.train_dataset)
            if _weighted_sampler is not None:
                return _weighted_sampler
            return super()._get_train_sampler(*a, **k)

    TrainerCls = _KolmOrderedTrainer if (_curriculum_active or _weighted_sampler is not None) else Trainer

    trainer_kwargs = dict(
        model=model,
        args=training,
        train_dataset=ds,
        data_collator=DataCollatorForLanguageModeling(tok, mlm=False),
        callbacks=callbacks,
    )
    if eval_ds is not None:
        trainer_kwargs["eval_dataset"] = eval_ds
    # W921 — inject the hand-built optimizer for LoRA+/LoRA-FA (scheduler left
    # to the Trainer default by passing (optim, None)).
    if custom_optimizer is not None:
        trainer_kwargs["optimizers"] = (custom_optimizer, None)
    trainer = TrainerCls(**trainer_kwargs)

    resume_arg = args.resume_from_checkpoint.strip() or None
    if resume_arg:
        if not os.path.isdir(resume_arg):
            sys.stderr.write(f"[train_lora] --resume-from-checkpoint not found: {resume_arg}\n")
            sys.exit(8)
        print(f"[train_lora] resuming from {resume_arg}")
        trainer.train(resume_from_checkpoint=resume_arg)
    else:
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

    holdout_metrics = {}
    if args.holdout:
        try:
            holdout_metrics = evaluate_student_holdout(model, tok, args.holdout, args.max_length, torch)
            if holdout_metrics.get("student_holdout_accuracy") is not None:
                print("[train_lora] holdout student token accuracy: "
                      f"{holdout_metrics['student_holdout_accuracy']:.4f} "
                      f"over {holdout_metrics.get('holdout_token_count', 0)} tokens")
            else:
                sys.stderr.write("[train_lora] holdout supplied but no scorable response tokens were found\n")
        except Exception as e:
            holdout_metrics = {
                "student_holdout_accuracy": None,
                "holdout_accuracy": None,
                "holdout_path": args.holdout,
                "holdout_eval_error": str(e),
            }
            sys.stderr.write(f"[train_lora] holdout evaluation failed: {e}\n")

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
            "backend": {
                "selected": "hf",
                "reason": backend_plan["reason"],
                "requested": backend_plan["requested"],
                "unsloth_importable": backend_plan["unsloth_importable"],
                "unsloth_supported": backend_plan["unsloth_supported"],
                "hf_only_features": backend_plan["hf_only_features"],
                "neftune_noise_alpha": float(neftune_alpha) if neftune_alpha else 0.0,
            },
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
                "liger_kernel": bool(liger_plan.get("applied")),
                "liger": liger_plan,
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
            "massive": {
                "gradient_accumulation_steps": args.gradient_accumulation_steps,
                "effective_batch_size": args.batch_size * args.gradient_accumulation_steps,
                "save_strategy": save_strategy,
                "save_steps": args.save_steps if args.save_steps > 0 else None,
                "eval_steps": args.eval_steps if args.eval_steps > 0 else None,
                "val_fraction": args.val_fraction if args.val_fraction > 0 else None,
                "val_rows": len(eval_ds) if eval_ds is not None else 0,
                "resumed_from": resume_arg,
                "qlora": False,
                "optim": trainer_optim,
                "max_grad_norm": args.max_grad_norm,
                "warmup_ratio": args.warmup_ratio,
                "save_total_limit": args.save_total_limit,
            },
            # W713/W711 — data-ordering provenance so the .kolm receipt chain
            # documents whether the student was trained under a curriculum
            # (SequentialSampler) or importance-weighted (WeightedRandomSampler)
            # regime. Both null/false on the default shuffle path.
            "ordering": ordering_meta,
        }, f, indent=2)

    print(f"[train_lora] done. adapter at {args.out}")


if __name__ == "__main__":
    main()
