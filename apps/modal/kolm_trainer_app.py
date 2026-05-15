"""kolm-trainer: Modal app template.

Deploy with:

    modal deploy kolm_trainer_app.py

This file is intended to be cloned by a kolm user into their own Modal
account. After ``modal deploy`` the function ``train_lora`` becomes
addressable from the ``modal`` backend adapter in apps/trainer/backends/
via ``modal.Function.lookup("kolm-trainer", "train_lora")``.

Input contract (matches apps/trainer/backends/modal_runner.py):

    {
      "spec": {
        "tenant":        str,
        "namespace":     str,
        "base_model":    str,   # any HF causal LM id
        "target_size":   str,   # e.g. "7b", "0.5b" (informational)
        "pair_count":    int,   # cap enforced server-side at 50000
        "corpus_url":    str,   # https URL pointing to JSONL
        "holdout_ratio": float, # 0.0 .. 0.5
      }
    }

Output envelope (matches the runner's expected shape):

    {
      "metrics":          {accuracy, k_score, ...},
      "adapter_bytes":    "<base64 zip>",
      "adapter_filename": "adapter.zip",
      "adapter_format":   "peft-lora",
      "device":           "modal-A100-40GB",
      "cost_usd":         <duration_seconds/3600 * hourly_rate>,
    }

Receipts: the metrics dict includes the same canonical-JSON receipt
fields the local trainer emits, so receipt verification is identical
regardless of which backend produced the run.

This file has NO imports from the kolm codebase. It is self-contained
and ships verbatim to the user.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import time
import zipfile
from pathlib import Path
from typing import Any

import modal


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

APP_NAME = os.environ.get("KOLM_MODAL_APP_NAME", "kolm-trainer")
FUNCTION_NAME = os.environ.get("KOLM_MODAL_FUNCTION_NAME", "train_lora")

# A100-40GB by default. Override via the KOLM_MODAL_GPU env var at deploy
# time. Modal accepts "A100", "A100-80GB", "H100", "L4", "L40S", "T4".
GPU_TYPE = os.environ.get("KOLM_MODAL_GPU", "A100-40GB")
TIMEOUT_SECONDS = int(os.environ.get("KOLM_MODAL_TIMEOUT_SECONDS", "1800"))
REGION = os.environ.get("KOLM_MODAL_REGION", "us-east")

# Per-hour billing on Modal A100-40GB is roughly $2.50/hr at the time
# this template ships. Override per region/sku if you have negotiated
# rates with Modal.
HOURLY_RATE_USD = float(os.environ.get("KOLM_MODAL_HOURLY_RATE_USD", "2.50"))

# Cap on input pair count. Prevents runaway training on a misconfigured
# corpus URL pointing at a multi-GB JSONL.
MAX_PAIR_COUNT = int(os.environ.get("KOLM_MODAL_MAX_PAIRS", "50000"))

# Common base preloaded into the cache volume at image-build time, so
# the cold-start of the very first call doesn't pay full base-model
# download latency. Override to whichever base is hot for your tenants.
DEFAULT_BASE_MODEL = os.environ.get("KOLM_MODAL_DEFAULT_BASE", "Qwen/Qwen2.5-0.5B-Instruct")


# ---------------------------------------------------------------------------
# Modal image + volume
# ---------------------------------------------------------------------------

# Pin Python 3.11, CUDA 12.1, torch 2.4. Versions match the local trainer's
# pyproject.toml so receipts are reproducible across backends.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    .pip_install(
        "torch>=2.4,<2.6",
        "transformers>=4.45",
        "peft>=0.13",
        "datasets>=3.0",
        "accelerate>=0.34",
        "bitsandbytes>=0.44",
        "httpx>=0.27",
        "safetensors>=0.4",
        "sentencepiece>=0.2",
    )
    .env(
        {
            "HF_HOME": "/cache/huggingface",
            "TRANSFORMERS_CACHE": "/cache/huggingface",
            "HF_DATASETS_CACHE": "/cache/datasets",
            "TOKENIZERS_PARALLELISM": "false",
        }
    )
)

# Persistent volume for the HF model cache. After the first call to a
# given base model the weights are reused across every subsequent run
# in this app, even across cold starts.
hf_cache = modal.Volume.from_name("kolm-hf-cache", create_if_missing=True)

app = modal.App(APP_NAME, image=image)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def _validate_spec(spec: dict[str, Any]) -> dict[str, Any]:
    """Validate the user-supplied training spec at the function boundary."""
    if not isinstance(spec, dict):
        raise ValueError(f"spec must be a dict, got {type(spec).__name__}")
    tenant = str(spec.get("tenant") or "").strip()
    namespace = str(spec.get("namespace") or "").strip()
    base_model = str(spec.get("base_model") or DEFAULT_BASE_MODEL).strip()
    target_size = str(spec.get("target_size") or "").strip()
    pair_count = int(spec.get("pair_count") or 0)
    corpus_url = str(spec.get("corpus_url") or "").strip()
    holdout_ratio = float(spec.get("holdout_ratio") or 0.1)

    if not tenant:
        raise ValueError("spec.tenant required")
    if not namespace:
        raise ValueError("spec.namespace required")
    if not corpus_url:
        raise ValueError("spec.corpus_url required")
    if not corpus_url.startswith("https://"):
        raise ValueError("spec.corpus_url must be https://")
    if pair_count < 0:
        raise ValueError("spec.pair_count must be >= 0")
    if pair_count > MAX_PAIR_COUNT:
        raise ValueError(f"spec.pair_count {pair_count} exceeds cap {MAX_PAIR_COUNT}")
    if not (0.0 <= holdout_ratio <= 0.5):
        raise ValueError("spec.holdout_ratio must be in [0.0, 0.5]")

    return {
        "tenant": tenant,
        "namespace": namespace,
        "base_model": base_model,
        "target_size": target_size,
        "pair_count": pair_count,
        "corpus_url": corpus_url,
        "holdout_ratio": holdout_ratio,
    }


# ---------------------------------------------------------------------------
# Canonical receipt JSON
# ---------------------------------------------------------------------------


def _canonical_json(value: Any) -> str:
    """Deterministic JSON. Matches the local trainer + Rust verifier."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


# ---------------------------------------------------------------------------
# Corpus loader
# ---------------------------------------------------------------------------


def _load_corpus(corpus_url: str, pair_count_cap: int) -> list[dict[str, str]]:
    import httpx

    with httpx.Client(timeout=120) as client:
        resp = client.get(corpus_url)
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
        prompt = row.get("prompt") or row.get("input") or ""
        completion = row.get("completion") or row.get("output") or row.get("expected") or ""
        if prompt or completion:
            out.append({"prompt": str(prompt), "completion": str(completion)})
        if pair_count_cap and len(out) >= pair_count_cap:
            break
    return out


# ---------------------------------------------------------------------------
# LoRA target inference (ports trainer_local.py verbatim)
# ---------------------------------------------------------------------------


def _infer_lora_targets(model) -> list[str]:
    """Pick LoRA target module names that exist for this architecture.

    GPT-2/DistilGPT2/TinyGPT-2 use ``c_attn`` (fused QKV).
    Llama/Qwen/Mistral/Gemma expose ``q_proj`` / ``k_proj`` / ``v_proj`` / ``o_proj``.
    Pythia/NeoX uses ``query_key_value``.
    """
    names = {name for name, _ in model.named_modules()}
    candidates = [
        ["q_proj", "k_proj", "v_proj", "o_proj"],
        ["query_key_value"],
        ["c_attn"],
    ]
    for group in candidates:
        present = [g for g in group if any(n.endswith(g) for n in names)]
        if present:
            return present
    return ["c_attn"]


def _count_params(model) -> tuple[int, int]:
    trainable, total = 0, 0
    for p in model.parameters():
        total += p.numel()
        if p.requires_grad:
            trainable += p.numel()
    return trainable, total


class _SFTDataset:
    def __init__(self, pairs, tokenizer, max_length=512):
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
        inputs = tokenizer(prompt, return_tensors="pt", truncation=True, max_length=512)
        inputs = {k: v.to(device) for k, v in inputs.items()}
        with torch.no_grad():
            out_ids = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                pad_token_id=tokenizer.pad_token_id,
            )
        gen = tokenizer.decode(
            out_ids[0][inputs["input_ids"].shape[1]:],
            skip_special_tokens=True,
        ).strip()
        hit = bool(expected) and (gen == expected or gen.startswith(expected) or expected in gen)
        if hit:
            correct += 1
        samples.append(
            {"prompt": prompt[:80], "expected": expected[:80], "got": gen[:80], "hit": hit}
        )
    accuracy = correct / len(eval_pairs) if eval_pairs else 0.0
    return accuracy, samples


def _zip_adapter_dir(out_dir: Path) -> tuple[bytes, str, int, int]:
    """Pack the adapter into an in-memory zip and return (bytes, sha256, total_bytes, file_count).

    Hashes match the local trainer: relative path + NUL + file bytes per entry, sorted.
    """
    hasher = hashlib.sha256()
    total = 0
    count = 0
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for fp in sorted(out_dir.rglob("*")):
            if not fp.is_file():
                continue
            if "_hf" in fp.parts:
                continue
            rel = fp.relative_to(out_dir).as_posix()
            data = fp.read_bytes()
            hasher.update(rel.encode("utf-8"))
            hasher.update(b"\x00")
            hasher.update(data)
            zf.writestr(rel, data)
            total += len(data)
            count += 1
    return buf.getvalue(), hasher.hexdigest(), total, count


# ---------------------------------------------------------------------------
# The training function
# ---------------------------------------------------------------------------


@app.function(
    name=FUNCTION_NAME,
    image=image,
    gpu=GPU_TYPE,
    timeout=TIMEOUT_SECONDS,
    volumes={"/cache": hf_cache},
)
def train_lora(spec: dict[str, Any]) -> dict[str, Any]:
    """Train a LoRA adapter and return metrics + adapter bytes.

    Algorithm ported verbatim from apps/trainer/trainer_local.py with
    the QLoRA fast-path enabled for GPU (bitsandbytes 4-bit when the
    base model is large enough to benefit).
    """
    import torch
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    from transformers import (
        AutoModelForCausalLM,
        AutoTokenizer,
        BitsAndBytesConfig,
        DataCollatorForLanguageModeling,
        Trainer,
        TrainingArguments,
    )

    started_at = time.time()
    spec = _validate_spec(spec)
    base_model_id = spec["base_model"]

    # ----- load corpus -----
    pairs = _load_corpus(spec["corpus_url"], spec["pair_count"] or MAX_PAIR_COUNT)
    if not pairs:
        raise ValueError("corpus is empty (expected JSONL of {prompt, completion})")
    holdout_n = max(1, int(len(pairs) * spec["holdout_ratio"]))
    train_pairs = pairs[:-holdout_n]
    eval_pairs = pairs[-holdout_n:]

    # ----- pick device + dtype -----
    device = "cuda" if torch.cuda.is_available() else "cpu"
    bf16_ok = device == "cuda" and torch.cuda.is_bf16_supported()

    # ----- load model -----
    tokenizer = AutoTokenizer.from_pretrained(base_model_id, trust_remote_code=False)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token or tokenizer.unk_token or "<|endoftext|>"

    use_qlora = device == "cuda"
    if use_qlora:
        bnb = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16 if bf16_ok else torch.float16,
            bnb_4bit_use_double_quant=True,
        )
        model = AutoModelForCausalLM.from_pretrained(
            base_model_id,
            quantization_config=bnb,
            device_map={"": 0},
            trust_remote_code=False,
        )
        model = prepare_model_for_kbit_training(model)
    else:
        model = AutoModelForCausalLM.from_pretrained(
            base_model_id,
            torch_dtype=torch.float32,
            trust_remote_code=False,
        )
        model.to(device)

    # ----- attach LoRA -----
    target_modules = _infer_lora_targets(model)
    lora_config = LoraConfig(
        r=16,
        lora_alpha=32,
        lora_dropout=0.05,
        target_modules=target_modules,
        bias="none",
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, lora_config)
    trainable, total = _count_params(model)

    # ----- train -----
    out_dir = Path(f"/tmp/kolm-adapter-{spec['namespace']}-{int(started_at)}")
    out_dir.mkdir(parents=True, exist_ok=True)

    train_dataset = _SFTDataset(train_pairs, tokenizer, max_length=512)
    collator = DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False)

    args = TrainingArguments(
        output_dir=str(out_dir / "_hf"),
        per_device_train_batch_size=2,
        gradient_accumulation_steps=4,
        num_train_epochs=int(os.environ.get("KOLM_MODAL_EPOCHS", "3")),
        learning_rate=2e-4,
        logging_steps=10,
        save_strategy="no",
        report_to=[],
        bf16=bf16_ok,
        fp16=device == "cuda" and not bf16_ok,
        dataloader_pin_memory=False,
        remove_unused_columns=False,
        optim="paged_adamw_8bit" if use_qlora else "adamw_torch",
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

    # ----- evaluate -----
    accuracy, sample_outputs = _eval_exact_match(
        model=model,
        tokenizer=tokenizer,
        eval_pairs=eval_pairs,
        device=device,
        max_new_tokens=int(os.environ.get("KOLM_MODAL_EVAL_MAX_NEW", "32")),
    )

    # ----- save + pack -----
    model.save_pretrained(str(out_dir))
    adapter_zip, adapter_sha, total_bytes, file_count = _zip_adapter_dir(out_dir)
    adapter_b64 = base64.b64encode(adapter_zip).decode("ascii")

    finished_at = time.time()
    duration_seconds = finished_at - started_at
    cost_usd = round((duration_seconds / 3600.0) * HOURLY_RATE_USD, 6)

    # K-score: convex combination of accuracy and compression efficiency.
    # The local trainer computes this in the kolm runtime layer; we mirror
    # the canonical formula here so receipts are byte-equivalent.
    k_score = round(0.7 * accuracy + 0.3 * min(1.0, trainable / max(1, total) * 10), 4)

    metrics = {
        "pair_count": len(pairs),
        "holdout_pair_count": holdout_n,
        "holdout_accuracy": round(accuracy, 4),
        "accuracy": round(accuracy, 4),
        "k_score": k_score,
        "training_loss_final": float(train_result.training_loss),
        "epochs": int(args.num_train_epochs),
        "steps": int(train_result.global_step),
        "base_model": base_model_id,
        "target_size": spec["target_size"],
        "device": device,
        "mode": "modal",
        "trainable_params": trainable,
        "total_params": total,
        "trainable_pct": round(100.0 * trainable / max(1, total), 4),
        "train_seconds": round(train_secs, 3),
        "lora_r": lora_config.r,
        "lora_alpha": lora_config.lora_alpha,
        "lora_targets": list(target_modules),
        "sample_outputs": sample_outputs[:3],
        "backend": "modal",
        "adapter_sha256": "sha256-" + adapter_sha,
        "adapter_size_bytes": total_bytes,
        "adapter_file_count": file_count,
    }

    # Canonical-JSON receipt header lets downstream verifiers re-hash
    # the spec bytes deterministically. Matches packages/runtime-rs.
    receipt = {
        "spec": spec,
        "metrics": metrics,
        "compute": {
            "backend": "modal",
            "device": f"modal-{GPU_TYPE}",
            "duration_seconds": round(duration_seconds, 3),
            "cost_usd": cost_usd,
        },
    }
    metrics["receipt_canonical_sha256"] = hashlib.sha256(
        _canonical_json(receipt).encode("utf-8")
    ).hexdigest()

    # Persist HF cache so subsequent calls don't re-download base weights.
    hf_cache.commit()

    return {
        "metrics": metrics,
        "adapter_bytes": adapter_b64,
        "adapter_filename": f"{spec['namespace']}.adapter.zip",
        "adapter_format": "peft-lora",
        "device": f"modal-{GPU_TYPE}",
        "cost_usd": cost_usd,
        "duration_seconds": round(duration_seconds, 3),
    }


# ---------------------------------------------------------------------------
# Local smoke entrypoint
# ---------------------------------------------------------------------------


@app.local_entrypoint()
def smoke(corpus_url: str = "", base_model: str = "sshleifer/tiny-gpt2") -> None:
    """Smoke test: `modal run kolm_trainer_app.py::smoke --corpus-url https://...`.

    Submits a tiny job and prints the metrics so you can verify the deploy
    end-to-end before pointing kolm at it.
    """
    if not corpus_url:
        print("usage: modal run kolm_trainer_app.py::smoke --corpus-url <https-url>")
        return
    spec = {
        "tenant": "smoke",
        "namespace": "smoke-test",
        "base_model": base_model,
        "target_size": "tiny",
        "pair_count": 32,
        "corpus_url": corpus_url,
        "holdout_ratio": 0.1,
    }
    result = train_lora.remote(spec)
    metrics = result.get("metrics", {})
    print(json.dumps({
        "device": result.get("device"),
        "cost_usd": result.get("cost_usd"),
        "duration_seconds": result.get("duration_seconds"),
        "accuracy": metrics.get("accuracy"),
        "k_score": metrics.get("k_score"),
        "adapter_size_bytes": metrics.get("adapter_size_bytes"),
        "adapter_filename": result.get("adapter_filename"),
    }, indent=2))
