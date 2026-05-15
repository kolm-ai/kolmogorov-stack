"""Local LoRA training. No CUDA, no Unsloth, no bitsandbytes.

This is the path that runs on every machine — Windows laptops without a GPU,
M-series Macs, Linux CI boxes. Backed by stock transformers + peft on torch
CPU (or MPS on Apple Silicon when available).

Inputs are the same as trainer_real.run_real_training: the Job dataclass,
an adapter output directory, and an on_progress callback. Outputs the same
shape: {"metrics": {...}, "adapter": {url, sha256, size_bytes, format}}.

Trade-off vs trainer_real (CUDA Unsloth path):
  * Slower per step (no kernel fusion, no flash-attention).
  * Full precision (no 4-bit quant); fits a 70M-1.5B base on commodity RAM.
  * Real gradients, real adapter, byte-equivalent safetensors output.

Default base_model: ``sshleifer/tiny-gpt2`` — a 1.5 MB causal LM stub that
exists precisely so end-to-end pipelines can run in seconds without
downloading hundreds of MB. Production callers pass any HF causal LM via
job.base_model (e.g. ``EleutherAI/pythia-70m``, ``distilgpt2``,
``Qwen/Qwen2.5-0.5B-Instruct``). The corpus contract is unchanged: JSONL
of ``{"prompt": str, "completion": str}``.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any, Callable

# Defaults are deliberately tiny so the local path never blocks on a
# multi-GB download. Override via the Job.base_model field if you want a
# real model.
DEFAULT_LOCAL_MODEL = os.environ.get("KOLM_LOCAL_BASE_MODEL", "sshleifer/tiny-gpt2")


def _pick_device(torch_mod) -> str:
    if getattr(torch_mod.backends, "mps", None) and torch_mod.backends.mps.is_available():
        return "mps"
    return "cpu"


def _resolve_base_model(job) -> str:
    # Job.base_model defaults to the registry canonical (Qwen/Qwen2.5-3B-Instruct).
    # On the local CPU path we rewrite anything that's too big (>1.5B) or a
    # GGUF/Unsloth alias to a CPU-friendly default (sshleifer/tiny-gpt2) so
    # callers do not have to special-case the backend they are hitting.
    bm = (getattr(job, "base_model", "") or "").strip()
    if not bm or bm.endswith("-q4_0") or "unsloth" in bm.lower() or "_q4" in bm.lower():
        return DEFAULT_LOCAL_MODEL
    # Heuristic: anything 3B+ is too heavy for CPU. Fall back to the tiny default.
    for big in ("3B", "3b", "7B", "7b", "14B", "14b", "12B", "12b", "8B", "8b"):
        if big in bm:
            return DEFAULT_LOCAL_MODEL
    return bm


async def run_local_training(job, adapter_dir: Path, on_progress: Callable[[str, int], None]) -> dict[str, Any]:
    """Run a real LoRA training pass on CPU/MPS and return metrics + adapter pointer.

    Lazy-imports torch/transformers/peft so the mock path stays free of heavy
    deps. Designed to be safe on machines with as little as 4 GB of free RAM.
    """
    import httpx
    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import (
        AutoModelForCausalLM,
        AutoTokenizer,
        DataCollatorForLanguageModeling,
        Trainer,
        TrainingArguments,
    )
    from torch.utils.data import Dataset

    device = _pick_device(torch)
    base_model_id = _resolve_base_model(job)

    on_progress("loading_corpus", 5)
    pairs = await _load_corpus(job)
    if not pairs:
        raise ValueError("corpus is empty (expected JSONL of {prompt, completion})")
    holdout_n = max(1, int(len(pairs) * (job.holdout_ratio or 0.1)))
    train_pairs = pairs[:-holdout_n]
    eval_pairs = pairs[-holdout_n:]

    on_progress("loading_model", 20)
    tokenizer = AutoTokenizer.from_pretrained(base_model_id)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token or tokenizer.unk_token or "<|endoftext|>"
    model = AutoModelForCausalLM.from_pretrained(base_model_id, torch_dtype=torch.float32)
    model.to(device)

    on_progress("attaching_lora", 35)
    target_modules = _infer_lora_targets(model)
    lora_config = LoraConfig(
        r=8,
        lora_alpha=16,
        lora_dropout=0.05,
        target_modules=target_modules,
        bias="none",
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, lora_config)
    trainable, total = _count_params(model)

    on_progress("training", 50)
    out_dir = adapter_dir / job.job_id
    out_dir.mkdir(parents=True, exist_ok=True)

    train_dataset = _SFTDataset(train_pairs, tokenizer, max_length=256)
    collator = DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False)

    args = TrainingArguments(
        output_dir=str(out_dir / "_hf"),
        per_device_train_batch_size=2,
        gradient_accumulation_steps=2,
        num_train_epochs=int(os.environ.get("KOLM_LOCAL_EPOCHS", "1")),
        learning_rate=5e-4,
        logging_steps=5,
        save_strategy="no",
        report_to=[],
        use_cpu=(device == "cpu"),
        fp16=False,
        bf16=False,
        dataloader_pin_memory=False,
        remove_unused_columns=False,
    )
    trainer = Trainer(
        model=model,
        args=args,
        train_dataset=train_dataset,
        data_collator=collator,
    )
    t0 = time.time()
    train_result = trainer.train()
    train_secs = time.time() - t0

    on_progress("evaluating", 85)
    accuracy, sample_outputs = _eval_exact_match(
        model=model,
        tokenizer=tokenizer,
        eval_pairs=eval_pairs,
        device=device,
        max_new_tokens=int(os.environ.get("KOLM_LOCAL_EVAL_MAX_NEW", "32")),
    )

    on_progress("packaging_adapter", 95)
    model.save_pretrained(str(out_dir))
    adapter_sha, total_bytes, file_count = _hash_adapter_dir(out_dir)

    on_progress("complete", 100)
    return {
        "metrics": {
            "pair_count": len(pairs),
            "holdout_pair_count": holdout_n,
            "holdout_accuracy": round(accuracy, 4),
            "training_loss_final": float(train_result.training_loss),
            "epochs": int(args.num_train_epochs),
            "steps": int(train_result.global_step),
            "base_model": base_model_id,
            "target_size": job.target_size,
            "device": device,
            "mode": "local",
            "trainable_params": trainable,
            "total_params": total,
            "trainable_pct": round(100.0 * trainable / max(1, total), 4),
            "train_seconds": round(train_secs, 3),
            "lora_r": lora_config.r,
            "lora_alpha": lora_config.lora_alpha,
            "lora_targets": list(target_modules),
            "sample_outputs": sample_outputs[:3],
        },
        "adapter": {
            "url": f"file://{out_dir.resolve().as_posix()}",
            "sha256": "sha256-" + adapter_sha,
            "size_bytes": total_bytes,
            "file_count": file_count,
            "format": "peft-lora",
        },
    }


async def _load_corpus(job) -> list[dict[str, str]]:
    import httpx

    if not job.corpus_url:
        raise ValueError("corpus_url required")
    if job.corpus_url.startswith("file://"):
        path = Path(job.corpus_url[7:].lstrip("/")) if os.name != "nt" else Path(job.corpus_url[8:])
        text = path.read_text(encoding="utf-8")
    else:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.get(job.corpus_url)
            resp.raise_for_status()
            text = resp.text
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        prompt = row.get("prompt") or row.get("input") or ""
        completion = row.get("completion") or row.get("output") or row.get("expected") or ""
        if prompt or completion:
            out.append({"prompt": str(prompt), "completion": str(completion)})
    return out


def _infer_lora_targets(model) -> list[str]:
    """Pick LoRA target module names that exist for this architecture.

    GPT-2/DistilGPT2/TinyGPT-2 use ``c_attn`` (fused QKV).
    Llama/Qwen/Mistral expose ``q_proj`` / ``k_proj`` / ``v_proj`` / ``o_proj``.
    Pythia/NeoX uses ``query_key_value``. We probe by name to stay generic.
    """
    names = {name for name, _ in model.named_modules()}
    candidates = [
        ["q_proj", "k_proj", "v_proj", "o_proj"],
        ["query_key_value"],
        ["c_attn"],
    ]
    for group in candidates:
        if any(any(n.endswith(g) for n in names) for g in group):
            return [g for g in group if any(n.endswith(g) for n in names)]
    return ["c_attn"]


def _count_params(model) -> tuple[int, int]:
    trainable, total = 0, 0
    for p in model.parameters():
        total += p.numel()
        if p.requires_grad:
            trainable += p.numel()
    return trainable, total


class _SFTDataset:
    def __init__(self, pairs, tokenizer, max_length=256):
        self.pairs = pairs
        self.tokenizer = tokenizer
        self.max_length = max_length

    def __len__(self):
        return len(self.pairs)

    def __getitem__(self, i):
        row = self.pairs[i]
        text = (row.get("prompt", "") + "\n" + row.get("completion", "")).strip()
        enc = self.tokenizer(
            text,
            truncation=True,
            max_length=self.max_length,
            padding=False,
            return_tensors=None,
        )
        return {"input_ids": enc["input_ids"], "attention_mask": enc["attention_mask"]}


def _eval_exact_match(model, tokenizer, eval_pairs, device, max_new_tokens=32):
    import torch

    model.eval()
    correct = 0
    samples = []
    for ex in eval_pairs:
        prompt = ex.get("prompt", "")
        expected = (ex.get("completion") or "").strip()
        inputs = tokenizer(prompt, return_tensors="pt", truncation=True, max_length=256)
        inputs = {k: v.to(device) for k, v in inputs.items()}
        with torch.no_grad():
            out_ids = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                pad_token_id=tokenizer.pad_token_id,
            )
        gen = tokenizer.decode(out_ids[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True).strip()
        hit = bool(expected) and (gen == expected or gen.startswith(expected) or expected in gen)
        if hit:
            correct += 1
        samples.append({"prompt": prompt[:80], "expected": expected[:80], "got": gen[:80], "hit": hit})
    accuracy = correct / len(eval_pairs) if eval_pairs else 0.0
    return accuracy, samples


def _hash_adapter_dir(out_dir: Path) -> tuple[str, int, int]:
    """Canonical, deterministic hash of the adapter directory tree.

    Excludes the ``_hf`` scratch dir written by TrainingArguments.output_dir.
    """
    hasher = hashlib.sha256()
    total = 0
    count = 0
    for fp in sorted(out_dir.rglob("*")):
        if not fp.is_file():
            continue
        if "_hf" in fp.parts:
            continue
        rel = fp.relative_to(out_dir).as_posix().encode("utf-8")
        data = fp.read_bytes()
        hasher.update(rel)
        hasher.update(b"\x00")
        hasher.update(data)
        total += len(data)
        count += 1
    return hasher.hexdigest(), total, count
