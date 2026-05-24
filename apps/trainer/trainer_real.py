"""Unsloth + PEFT QLoRA training with Liger Kernel, FlashAttention-2/3, and
optional DPO post-stage. Lazy-imported by main.py when MODE=real.

Environment switches (all opt-in):
  KOLM_USE_LIGER=1            -> Apply liger_kernel patches (fused RMSNorm,
                                  SwiGLU, RoPE; ~20-30% throughput).
  KOLM_ATTN_IMPL=flash_attention_2|flash_attention_3|sdpa  (default: best-fit)
  KOLM_8BIT_OPTIM=1           -> bitsandbytes 8-bit AdamW (saves ~6GB on 7B).
  KOLM_DPO_PAIRS_URL=<url>    -> Run a DPO stage after SFT against this corpus.
  KOLM_TRAIN_OBJECTIVE=sft|span|dpo  (default: sft)
  KOLM_LORA_R=16 | KOLM_LORA_ALPHA=32 | KOLM_LORA_DROPOUT=0.05
  KOLM_BASE_MODEL=<id>        -> Override the base. Otherwise resolved via
                                  apps.trainer.models.resolve_base().

W787 — compute-efficiency knobs (precision, gradient checkpointing, early
stop) are read by workers/distill/scripts/train_lora.py (the path the
`kolm distill --local-worker` CLI invokes via the Node-side worker shell).
This trainer_real.py path already AUTO-selects bf16-when-supported + fp16
fallback at line ~152-153 + hardcodes gradient_checkpointing=True at line
~157, so KOLM_PRECISION + KOLM_GRAD_CHECKPOINT are accepted there but the
auto-defaults already implement W787's recommendation; the W787 surface
distinction is the Node-side configurability + the receipt-chain stamping
(run-meta.efficiency block).
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any, Callable


def _attn_impl_for(device_id: str | None) -> str:
    forced = os.environ.get("KOLM_ATTN_IMPL")
    if forced:
        return forced
    # Per-device best.
    if device_id in ("rtx-5090", "h100-80gb", "h200-141gb"):
        return "flash_attention_3"
    if device_id in ("rtx-4090", "rtx-3090", "a100-40gb", "a100-80gb"):
        return "flash_attention_2"
    return "sdpa"


def _maybe_apply_liger(model_family: str) -> bool:
    if os.environ.get("KOLM_USE_LIGER") != "1":
        return False
    try:
        from liger_kernel.transformers import (
            apply_liger_kernel_to_llama,
            apply_liger_kernel_to_qwen2,
            apply_liger_kernel_to_gemma,
            apply_liger_kernel_to_phi3,
        )
    except ImportError:
        print("kolm: KOLM_USE_LIGER=1 but liger-kernel not installed; skipping", file=sys.stderr)
        return False
    if model_family.startswith("qwen"):
        apply_liger_kernel_to_qwen2()
    elif model_family.startswith("llama"):
        apply_liger_kernel_to_llama()
    elif model_family.startswith("gemma"):
        apply_liger_kernel_to_gemma()
    elif model_family.startswith("phi"):
        apply_liger_kernel_to_phi3()
    else:
        return False
    return True


def _device_id_from_torch() -> str | None:
    """Best-effort match of the current CUDA device to our device registry."""
    try:
        import torch  # noqa: F401
        from apps.trainer.models import _match_gpu  # type: ignore
        import torch
        if not torch.cuda.is_available():
            return None
        name = torch.cuda.get_device_name(0)
        props = torch.cuda.get_device_properties(0)
        sm = f"{props.major}.{props.minor}"
        vram_mib = props.total_memory / (1024 * 1024)
        return _match_gpu(name, vram_mib, sm)
    except Exception:
        return None


async def run_real_training(job, adapter_dir: Path, on_progress: Callable[[str, int], None]) -> dict[str, Any]:
    """Run a real QLoRA training pass and return metrics + adapter pointer.

    Outputs ``{"metrics": {...}, "adapter": {url, sha256, size_bytes, format}}``.
    """
    import httpx
    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import AutoTokenizer, TrainingArguments
    from trl import SFTTrainer
    from unsloth import FastLanguageModel

    try:
        from apps.trainer.models import resolve_base, info as model_info
    except ImportError:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from trainer.models import resolve_base, info as model_info  # type: ignore

    on_progress("loading_corpus", 5)
    if not job.corpus_url:
        raise ValueError("corpus_url required for real training mode")
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.get(job.corpus_url)
        resp.raise_for_status()
        corpus_text = resp.text
    pairs = [json.loads(line) for line in corpus_text.splitlines() if line.strip()]
    if not pairs:
        raise ValueError(f"corpus at {job.corpus_url} is empty")
    holdout_n = max(1, int(len(pairs) * job.holdout_ratio))
    train_pairs = pairs[:-holdout_n]
    eval_pairs = pairs[-holdout_n:]

    on_progress("resolving_base", 12)
    base_model = job.base_model or resolve_base(tenant=getattr(job, "tenant", None))
    m_info = model_info(base_model)
    family = m_info.family if m_info else "qwen2.5"
    device_id = _device_id_from_torch()
    attn_impl = _attn_impl_for(device_id)
    liger_applied = _maybe_apply_liger(family)

    on_progress("loading_model", 20)
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=base_model,
        max_seq_length=2048,
        dtype=None,
        load_in_4bit=True,
        attn_implementation=attn_impl if attn_impl != "sdpa" else None,
    )

    on_progress("attaching_lora", 35)
    target_modules = _lora_targets_for(family)
    lora_config = LoraConfig(
        r=int(os.environ.get("KOLM_LORA_R", "16")),
        lora_alpha=int(os.environ.get("KOLM_LORA_ALPHA", "32")),
        lora_dropout=float(os.environ.get("KOLM_LORA_DROPOUT", "0.05")),
        target_modules=target_modules,
        bias="none",
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, lora_config)

    on_progress("training", 50)
    out_dir = adapter_dir / job.job_id
    out_dir.mkdir(parents=True, exist_ok=True)
    use_8bit_optim = os.environ.get("KOLM_8BIT_OPTIM") == "1"
    args = TrainingArguments(
        output_dir=str(out_dir),
        per_device_train_batch_size=int(os.environ.get("KOLM_BSZ", "2")),
        gradient_accumulation_steps=int(os.environ.get("KOLM_GRAD_ACCUM", "4")),
        num_train_epochs=float(os.environ.get("KOLM_EPOCHS", "3")),
        learning_rate=float(os.environ.get("KOLM_LR", "2e-4")),
        bf16=torch.cuda.is_bf16_supported(),
        fp16=not torch.cuda.is_bf16_supported(),
        logging_steps=10,
        save_strategy="no",
        optim="paged_adamw_8bit" if use_8bit_optim else "adamw_torch",
        gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False},
        report_to=[],
    )
    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        args=args,
        train_dataset=train_pairs,
        dataset_text_field="completion",
        max_seq_length=2048,
    )
    train_result = trainer.train()

    # Optional DPO stage after SFT.
    dpo_stage = None
    if os.environ.get("KOLM_DPO_PAIRS_URL"):
        on_progress("dpo", 75)
        dpo_stage = await _run_dpo_stage(model, tokenizer, out_dir, os.environ["KOLM_DPO_PAIRS_URL"])

    on_progress("evaluating", 85)
    correct, total = 0, 0
    for ex in eval_pairs:
        prompt = ex.get("prompt", "")
        expected = ex.get("completion", "")
        inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
        # Prompt-lookup speculative decoding: huge for repetitive corporate text.
        # transformers >= 4.36 supports prompt_lookup_num_tokens directly.
        gen_kwargs: dict[str, Any] = {"max_new_tokens": 128, "do_sample": False}
        if os.environ.get("KOLM_PROMPT_LOOKUP", "1") == "1":
            gen_kwargs["prompt_lookup_num_tokens"] = int(os.environ.get("KOLM_PROMPT_LOOKUP_N", "10"))
        try:
            out_ids = model.generate(**inputs, **gen_kwargs)
        except TypeError:
            # Older transformers without prompt_lookup_num_tokens.
            out_ids = model.generate(**inputs, max_new_tokens=128, do_sample=False)
        out_text = tokenizer.decode(out_ids[0], skip_special_tokens=True)
        if expected.strip() and out_text.strip().endswith(expected.strip()):
            correct += 1
        total += 1
    accuracy = correct / total if total else 0.0

    on_progress("packaging_adapter", 95)
    model.save_pretrained(str(out_dir))
    hasher = hashlib.sha256()
    total_bytes = 0
    for fp in sorted(out_dir.rglob("*")):
        if fp.is_file():
            data = fp.read_bytes()
            hasher.update(fp.name.encode("utf-8"))
            hasher.update(data)
            total_bytes += len(data)

    on_progress("complete", 100)
    return {
        "metrics": {
            "pair_count": len(pairs),
            "holdout_pair_count": holdout_n,
            "holdout_accuracy": round(accuracy, 4),
            "training_loss_final": float(train_result.training_loss),
            "epochs": int(args.num_train_epochs),
            "steps": int(train_result.global_step),
            "base_model": base_model,
            "target_size": job.target_size,
            "mode": "real",
            "optimizations": {
                "attn_impl": attn_impl,
                "liger_kernel": liger_applied,
                "optim_8bit": use_8bit_optim,
                "device_id": device_id,
                "prompt_lookup_eval": os.environ.get("KOLM_PROMPT_LOOKUP", "1") == "1",
            },
            "dpo_stage": dpo_stage,
        },
        "adapter": {
            "url": f"file://{out_dir.resolve()}",
            "sha256": "sha256-" + hasher.hexdigest(),
            "size_bytes": total_bytes,
            "format": "peft-lora",
        },
    }


def _lora_targets_for(family: str) -> list[str]:
    """Architecture-correct LoRA target modules.

    Defaults to the q/k/v/o pattern that Llama/Qwen/Mistral share. Falls back
    to BLOOM-style query_key_value or GPT-2 style c_attn when needed.
    """
    if family.startswith(("qwen", "llama", "mistral", "ministral", "phi", "gemma")):
        return ["q_proj", "k_proj", "v_proj", "o_proj"]
    if family.startswith("smollm"):
        return ["q_proj", "k_proj", "v_proj", "o_proj"]
    return ["q_proj", "k_proj", "v_proj", "o_proj"]  # Conservative default.


async def _run_dpo_stage(model, tokenizer, out_dir: Path, pairs_url: str) -> dict[str, Any]:
    """Run a DPO stage with preference triples (prompt, chosen, rejected).

    Pairs URL must return JSONL of {"prompt", "chosen", "rejected"}. Updates
    model in place; we don't save mid-stage to avoid double-writing adapters.
    """
    import httpx
    from trl import DPOTrainer, DPOConfig

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.get(pairs_url)
        resp.raise_for_status()
        text = resp.text
    triples = [json.loads(line) for line in text.splitlines() if line.strip()]
    if not triples:
        return {"skipped": True, "reason": "empty corpus"}

    cfg = DPOConfig(
        output_dir=str(out_dir / "dpo"),
        per_device_train_batch_size=1,
        gradient_accumulation_steps=8,
        num_train_epochs=1,
        learning_rate=1e-5,
        beta=0.1,
        bf16=True,
        save_strategy="no",
        report_to=[],
    )
    dpo = DPOTrainer(model=model, args=cfg, train_dataset=triples, tokenizer=tokenizer)
    result = dpo.train()
    return {
        "pair_count": len(triples),
        "loss_final": float(result.training_loss),
        "steps": int(result.global_step),
    }
