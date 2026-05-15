"""local-rocm backend. Native LoRA training on AMD GPUs via PyTorch + ROCm.

PyTorch ROCm builds present the same ``torch.cuda`` API surface as the
NVIDIA build: ``torch.cuda.is_available()`` returns True, tensors move
with ``.to("cuda")``, autocast keys are ``cuda``. The only difference is
the wheel itself and the underlying runtime (HIP/ROCm vs CUDA).

Required deps:
  ROCm-built PyTorch (matching your ROCm version). See
  https://pytorch.org/get-started/locally/ and pick the ROCm variant for
  your distro + ROCm version. Example:
    pip install torch --index-url https://download.pytorch.org/whl/rocm6.0

Required env vars (auto-detected from rocm-smi if unset):
  HIP_VISIBLE_DEVICES    or  ROCR_VISIBLE_DEVICES: comma-separated device
                            indices, e.g. ``0`` for the first AMD GPU.

Optional env vars:
  KOLM_LOCAL_BASE_MODEL    HF model id; defaults to ``sshleifer/tiny-gpt2``.
  KOLM_ROCM_EPOCHS         training epochs, default 1
  KOLM_ROCM_BATCH_SIZE     micro-batch, default 2
  KOLM_ROCM_LR             learning rate, default 5e-4
  KOLM_ROCM_MAX_SEQ_LEN    max sequence length, default 256

Install hint on failure points at the upstream wheel selector.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any, Callable


INSTALL_HINT = (
    "install a ROCm-built PyTorch wheel from "
    "https://pytorch.org/get-started/locally/ (select ROCm in the matrix). "
    "Then set HIP_VISIBLE_DEVICES=0 (or your device index)."
)

DEFAULT_ROCM_MODEL = os.environ.get("KOLM_LOCAL_BASE_MODEL", "sshleifer/tiny-gpt2")
_MAX_PAIRS = 50000


def _verify_torch_rocm() -> Any:
    try:
        import torch
    except ImportError as err:
        raise RuntimeError(f"local-rocm: torch not importable ({err}). {INSTALL_HINT}") from err

    if not torch.cuda.is_available():
        raise RuntimeError(
            "local-rocm: torch.cuda.is_available() is False. "
            "Either no AMD GPU is visible or the ROCm runtime is not loaded. "
            f"{INSTALL_HINT}"
        )

    version = getattr(torch, "__version__", "")
    is_rocm = "+rocm" in version or "rocm" in version.lower()
    hip_ver = getattr(getattr(torch, "version", None), "hip", None)
    if not is_rocm and hip_ver is None:
        raise RuntimeError(
            f"local-rocm: torch {version} is not a ROCm build "
            "(torch.version.hip is None and `+rocm` missing from torch.__version__). "
            f"{INSTALL_HINT}"
        )
    return torch


def _validate_job(job) -> None:
    url = (job.corpus_url or "").strip()
    if not url:
        raise ValueError("local-rocm: corpus_url required")
    if not (url.startswith("https://") or url.startswith("file://")):
        raise ValueError("local-rocm: corpus_url must be https or file URL")
    if int(job.pair_count or 0) > _MAX_PAIRS:
        raise ValueError(f"local-rocm: pair_count {job.pair_count} exceeds cap {_MAX_PAIRS}")


def _resolve_base_model(job) -> str:
    bm = (getattr(job, "base_model", "") or "").strip()
    if not bm or bm.endswith("-q4_0") or "unsloth" in bm.lower() or "_q4" in bm.lower():
        return DEFAULT_ROCM_MODEL
    return bm


def _gpu_name(torch_mod) -> str:
    try:
        return str(torch_mod.cuda.get_device_name(0))
    except Exception:
        pass
    # rocm-smi is the AMD equivalent of nvidia-smi; fall back to it if
    # torch couldn't introspect the device.
    try:
        out = subprocess.check_output(
            ["rocm-smi", "--showproductname"], stderr=subprocess.STDOUT, timeout=5
        ).decode("utf-8", errors="replace")
        for line in out.splitlines():
            if "Card series" in line or "Card model" in line:
                return line.split(":", 1)[-1].strip()
    except Exception:
        pass
    return "amd-gpu"


def _rocm_version() -> str:
    try:
        out = subprocess.check_output(
            ["rocm-smi", "--version"], stderr=subprocess.STDOUT, timeout=5
        ).decode("utf-8", errors="replace").strip()
        return out.splitlines()[0] if out else "unknown"
    except Exception:
        return "unknown"


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
    torch = _verify_torch_rocm()
    _validate_job(job)

    started_at = time.time()
    base_model_id = _resolve_base_model(job)
    # PyTorch ROCm uses the cuda device API.
    device = "cuda"

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
        raise ValueError("local-rocm: corpus is empty (expected JSONL of {prompt, completion})")
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
        train_pairs, tokenizer, max_length=int(os.environ.get("KOLM_ROCM_MAX_SEQ_LEN", "256"))
    )
    collator = DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False)

    args = TrainingArguments(
        output_dir=str(out_dir / "_hf"),
        per_device_train_batch_size=int(os.environ.get("KOLM_ROCM_BATCH_SIZE", "2")),
        gradient_accumulation_steps=2,
        num_train_epochs=int(os.environ.get("KOLM_ROCM_EPOCHS", "1")),
        learning_rate=float(os.environ.get("KOLM_ROCM_LR", "5e-4")),
        logging_steps=5,
        save_strategy="no",
        report_to=[],
        use_cpu=False,
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
        max_new_tokens=int(os.environ.get("KOLM_ROCM_EVAL_MAX_NEW", "32")),
    )

    on_progress("packaging_adapter", 95)
    model.save_pretrained(str(out_dir))
    adapter_sha, total_bytes, file_count = _hash_adapter_dir(out_dir)

    finished_at = time.time()
    on_progress("complete", 100)

    gpu_name = _gpu_name(torch)
    visible = os.environ.get("HIP_VISIBLE_DEVICES") or os.environ.get("ROCR_VISIBLE_DEVICES") or ""

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
            "device": "amd-gpu-rocm",
            "mode": "local-rocm",
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
            "backend": "local-rocm",
            "device": "amd-gpu-rocm",
            "cost_usd": 0.0,
            "started_at": started_at,
            "finished_at": finished_at,
            "duration_seconds": round(finished_at - started_at, 3),
            "provenance": {
                "framework": "torch-rocm",
                "torch_version": getattr(torch, "__version__", "unknown"),
                "torch_hip": getattr(getattr(torch, "version", None), "hip", None) or "unknown",
                "gpu_name": gpu_name,
                "visible_devices": visible,
                "rocm_smi": _rocm_version(),
                "base_model": base_model_id,
            },
        },
    }
