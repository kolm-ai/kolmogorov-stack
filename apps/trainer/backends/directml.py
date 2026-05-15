"""local-directml backend. PyTorch via DirectML on Windows / WSL2.

DirectML is Microsoft's GPU-agnostic ML runtime that runs on top of DX12.
It's how we cover the long tail: Intel Arc / Iris Xe iGPUs, AMD cards
that aren't on a ROCm-supported distro, NVIDIA cards under WSL without
CUDA-on-Linux configured. The wheel ships as ``torch-directml`` and
exposes a single ``torch_directml.device()`` factory; the rest is stock
torch.

Required deps:
  pip install torch-directml
  See https://learn.microsoft.com/en-us/windows/ai/directml/pytorch-windows

Optional env vars:
  KOLM_LOCAL_BASE_MODEL    HF model id; defaults to ``sshleifer/tiny-gpt2``.
  KOLM_DIRECTML_EPOCHS     training epochs, default 1
  KOLM_DIRECTML_BATCH_SIZE micro-batch, default 2
  KOLM_DIRECTML_LR         learning rate, default 5e-4
  KOLM_DIRECTML_MAX_SEQ_LEN  max sequence length, default 256

Compatibility caveat: peft + transformers do not have full DirectML
coverage. A handful of ops (custom kernels, some attention paths) fall
back to CPU silently: training still produces a correct adapter but is
slower than a comparable native CUDA/ROCm run. The runner emits a warning
on start so the operator can see the trade-off in the job log.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
import warnings
from pathlib import Path
from typing import Any, Callable


log = logging.getLogger("kolm.trainer.directml")

INSTALL_HINT = (
    "install with `pip install torch-directml` (Windows / WSL2). "
    "See https://learn.microsoft.com/en-us/windows/ai/directml/pytorch-windows"
)

DEFAULT_DIRECTML_MODEL = os.environ.get("KOLM_LOCAL_BASE_MODEL", "sshleifer/tiny-gpt2")
_MAX_PAIRS = 50000

_COMPAT_WARNING = (
    "local-directml: peft/transformers compatibility with torch_directml is partial. "
    "Some kernels fall back to CPU silently. Training is correct, but slower than "
    "native CUDA or ROCm."
)


def _verify_imports() -> tuple[Any, Any]:
    try:
        import torch
    except ImportError as err:
        raise RuntimeError(f"local-directml: torch not importable ({err}). {INSTALL_HINT}") from err
    try:
        import torch_directml  # noqa: F401
    except ImportError as err:
        raise RuntimeError(f"local-directml: torch_directml not importable ({err}). {INSTALL_HINT}") from err
    import torch_directml

    available = False
    if hasattr(torch_directml, "is_available"):
        try:
            available = bool(torch_directml.is_available())
        except Exception:
            available = False
    if not available:
        try:
            available = int(torch_directml.device_count()) > 0
        except Exception:
            available = False
    if not available:
        raise RuntimeError(
            "local-directml: no DirectML device visible "
            "(torch_directml.is_available() False and device_count() == 0). "
            f"{INSTALL_HINT}"
        )

    return torch, torch_directml


def _validate_job(job) -> None:
    url = (job.corpus_url or "").strip()
    if not url:
        raise ValueError("local-directml: corpus_url required")
    if not (url.startswith("https://") or url.startswith("file://")):
        raise ValueError("local-directml: corpus_url must be https or file URL")
    if int(job.pair_count or 0) > _MAX_PAIRS:
        raise ValueError(f"local-directml: pair_count {job.pair_count} exceeds cap {_MAX_PAIRS}")


def _resolve_base_model(job) -> str:
    bm = (getattr(job, "base_model", "") or "").strip()
    if not bm or bm.endswith("-q4_0") or "unsloth" in bm.lower() or "_q4" in bm.lower():
        return DEFAULT_DIRECTML_MODEL
    return bm


def _device_name(torch_directml) -> str:
    try:
        return str(torch_directml.device_name(0))
    except Exception:
        return "windows-directml"


def _device_count(torch_directml) -> int:
    try:
        return int(torch_directml.device_count())
    except Exception:
        return 0


async def _load_corpus(job) -> list[dict[str, str]]:
    import httpx

    url = job.corpus_url
    if url.startswith("file://"):
        path = Path(url[8:]) if os.name == "nt" else Path(url[7:].lstrip("/"))
        text = path.read_text(encoding="utf-8")
    else:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            text = resp.text
    out: list[dict[str, str]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        prompt = str(row.get("prompt") or row.get("input") or "")
        completion = str(row.get("completion") or row.get("output") or row.get("expected") or "")
        if prompt or completion:
            out.append({"prompt": prompt, "completion": completion})
        if len(out) >= _MAX_PAIRS:
            break
    return out


def _infer_lora_targets(model) -> list[str]:
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


def _eval_exact_match(model, tokenizer, eval_pairs, device, max_new_tokens=32) -> tuple[float, list[dict[str, Any]]]:
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


async def run(job, adapter_dir: Path, on_progress: Callable[[str, int], None]) -> dict[str, Any]:
    torch, torch_directml = _verify_imports()
    _validate_job(job)

    log.warning(_COMPAT_WARNING)
    warnings.warn(_COMPAT_WARNING, stacklevel=2)

    started_at = time.time()
    base_model_id = _resolve_base_model(job)
    device = torch_directml.device()

    from peft import LoraConfig, get_peft_model
    from transformers import (
        AutoModelForCausalLM,
        AutoTokenizer,
        DataCollatorForLanguageModeling,
        Trainer,
        TrainingArguments,
    )

    on_progress("loading_corpus", 5)
    pairs = await _load_corpus(job)
    if not pairs:
        raise ValueError("local-directml: corpus is empty (expected JSONL of {prompt, completion})")
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

    train_dataset = _SFTDataset(
        train_pairs, tokenizer, max_length=int(os.environ.get("KOLM_DIRECTML_MAX_SEQ_LEN", "256"))
    )
    collator = DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False)

    args = TrainingArguments(
        output_dir=str(out_dir / "_hf"),
        per_device_train_batch_size=int(os.environ.get("KOLM_DIRECTML_BATCH_SIZE", "2")),
        gradient_accumulation_steps=2,
        num_train_epochs=int(os.environ.get("KOLM_DIRECTML_EPOCHS", "1")),
        learning_rate=float(os.environ.get("KOLM_DIRECTML_LR", "5e-4")),
        logging_steps=5,
        save_strategy="no",
        report_to=[],
        use_cpu=False,
        fp16=False,
        bf16=False,
        dataloader_pin_memory=False,
        remove_unused_columns=False,
        no_cuda=True,
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
        max_new_tokens=int(os.environ.get("KOLM_DIRECTML_EVAL_MAX_NEW", "32")),
    )

    on_progress("packaging_adapter", 95)
    model.save_pretrained(str(out_dir))
    adapter_sha, total_bytes, file_count = _hash_adapter_dir(out_dir)

    finished_at = time.time()
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
            "device": "windows-directml",
            "mode": "local-directml",
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
        "compute": {
            "backend": "local-directml",
            "device": "windows-directml",
            "cost_usd": 0.0,
            "started_at": started_at,
            "finished_at": finished_at,
            "duration_seconds": round(finished_at - started_at, 3),
            "provenance": {
                "framework": "torch-directml",
                "torch_version": getattr(torch, "__version__", "unknown"),
                "torch_directml_version": getattr(torch_directml, "__version__", "unknown"),
                "directml_devices": _device_count(torch_directml),
                "device_name": _device_name(torch_directml),
                "base_model": base_model_id,
                "compat_warning": _COMPAT_WARNING,
            },
        },
    }
