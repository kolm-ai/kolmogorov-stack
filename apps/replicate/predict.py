"""kolm-trainer Cog predictor.

Replicate runs this on every prediction. Build with `cog build` and
push with `cog push r8.im/<your-username>/kolm-trainer`.

Input contract (matches apps/trainer/backends/replicate_runner.py):

    spec = {
        "tenant":        str,
        "namespace":     str,
        "base_model":    str,
        "target_size":   str,
        "pair_count":    int,
        "corpus_url":    str,
        "holdout_ratio": float,
    }

Output envelope:

    {
        "metrics":          {accuracy, k_score, ...},
        "adapter_bytes":    "<base64 zip>",
        "adapter_filename": "...adapter.zip",
        "adapter_format":   "peft-lora",
        "device":           "replicate-A40",
        "cost_usd":         <float>,
    }

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

from cog import BasePredictor, Input


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# A40 is the Replicate default GPU. Override at build time by exporting
# KOLM_REPLICATE_GPU before `cog push`. Replicate also accepts A100
# variants on higher tier accounts.
GPU_TYPE = os.environ.get("KOLM_REPLICATE_GPU", "A40")

# Replicate A40 billing: $0.001525/sec = $5.49/hr.
HOURLY_RATE_USD = float(os.environ.get("KOLM_REPLICATE_HOURLY_RATE_USD", "5.49"))

MAX_PAIR_COUNT = int(os.environ.get("KOLM_REPLICATE_MAX_PAIRS", "50000"))

# Pre-warmed base. setup() pulls this so the first real call doesn't
# pay the multi-GB download cost on the prediction critical path.
DEFAULT_BASE_MODEL = os.environ.get(
    "KOLM_REPLICATE_DEFAULT_BASE", "Qwen/Qwen2.5-0.5B-Instruct"
)

SAMPLE_SPEC: dict[str, Any] = {
    "tenant": "demo",
    "namespace": "refund-classifier",
    "base_model": "sshleifer/tiny-gpt2",
    "target_size": "tiny",
    "pair_count": 32,
    "corpus_url": "https://raw.githubusercontent.com/kolmai/sample-corpora/main/refund_classifier.jsonl",
    "holdout_ratio": 0.1,
}


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def _validate_spec(spec: dict[str, Any]) -> dict[str, Any]:
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


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


# ---------------------------------------------------------------------------
# Shared training primitives (mirrors trainer_local.py + Modal app)
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


def _infer_lora_targets(model) -> list[str]:
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
# Cog predictor
# ---------------------------------------------------------------------------


class Predictor(BasePredictor):
    """LoRA fine-tune on Replicate."""

    def setup(self) -> None:
        """Pre-warm the default base model so the first real call is fast.

        Cog runs setup() once when the container boots; weights downloaded
        here go into the HF cache and are reused across predictions.
        """
        try:
            from transformers import AutoModelForCausalLM, AutoTokenizer

            os.environ.setdefault("HF_HOME", "/root/.cache/huggingface")
            os.environ.setdefault("TRANSFORMERS_CACHE", "/root/.cache/huggingface")
            os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

            # Touch the tokenizer + model so the weights land in the cache.
            # We don't keep references; the per-call code will reload them
            # with the correct dtype + quantization config.
            AutoTokenizer.from_pretrained(DEFAULT_BASE_MODEL, trust_remote_code=False)
            AutoModelForCausalLM.from_pretrained(
                DEFAULT_BASE_MODEL, trust_remote_code=False
            )
        except Exception as err:  # noqa: BLE001
            # Setup must never crash the container: a failed prewarm just
            # means the first real call pays the download cost.
            print(f"[setup] prewarm of {DEFAULT_BASE_MODEL} failed: {err}")

    def predict(
        self,
        spec: str = Input(
            description=(
                "JSON-encoded training spec. Fields: tenant, namespace, base_model, "
                "target_size, pair_count, corpus_url (https), holdout_ratio."
            ),
            default=json.dumps(SAMPLE_SPEC),
        ),
    ) -> dict[str, Any]:
        """Run a LoRA training pass and return metrics + adapter bytes."""
        import torch
        from peft import (
            LoraConfig,
            get_peft_model,
            prepare_model_for_kbit_training,
        )
        from transformers import (
            AutoModelForCausalLM,
            AutoTokenizer,
            BitsAndBytesConfig,
            DataCollatorForLanguageModeling,
            Trainer,
            TrainingArguments,
        )

        started_at = time.time()

        # Cog Input is a string at the wire level; the runner sends a
        # JSON-encoded dict. Accept either shape defensively.
        if isinstance(spec, str):
            try:
                spec_dict = json.loads(spec)
            except json.JSONDecodeError as err:
                raise ValueError(f"spec is not valid JSON: {err}") from err
        else:
            spec_dict = spec

        spec_dict = _validate_spec(spec_dict)
        base_model_id = spec_dict["base_model"]

        # ----- load corpus -----
        pairs = _load_corpus(spec_dict["corpus_url"], spec_dict["pair_count"] or MAX_PAIR_COUNT)
        if not pairs:
            raise ValueError("corpus is empty (expected JSONL of {prompt, completion})")
        holdout_n = max(1, int(len(pairs) * spec_dict["holdout_ratio"]))
        train_pairs = pairs[:-holdout_n]
        eval_pairs = pairs[-holdout_n:]

        # ----- pick device + dtype -----
        device = "cuda" if torch.cuda.is_available() else "cpu"
        bf16_ok = device == "cuda" and torch.cuda.is_bf16_supported()

        # ----- load model -----
        tokenizer = AutoTokenizer.from_pretrained(base_model_id, trust_remote_code=False)
        if tokenizer.pad_token is None:
            tokenizer.pad_token = (
                tokenizer.eos_token or tokenizer.unk_token or "<|endoftext|>"
            )

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
        out_dir = Path(f"/tmp/kolm-adapter-{spec_dict['namespace']}-{int(started_at)}")
        out_dir.mkdir(parents=True, exist_ok=True)

        train_dataset = _SFTDataset(train_pairs, tokenizer, max_length=512)
        collator = DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False)

        args = TrainingArguments(
            output_dir=str(out_dir / "_hf"),
            per_device_train_batch_size=2,
            gradient_accumulation_steps=4,
            num_train_epochs=int(os.environ.get("KOLM_REPLICATE_EPOCHS", "3")),
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
            max_new_tokens=int(os.environ.get("KOLM_REPLICATE_EVAL_MAX_NEW", "32")),
        )

        # ----- save + pack -----
        model.save_pretrained(str(out_dir))
        adapter_zip, adapter_sha, total_bytes, file_count = _zip_adapter_dir(out_dir)
        adapter_b64 = base64.b64encode(adapter_zip).decode("ascii")

        finished_at = time.time()
        duration_seconds = finished_at - started_at
        cost_usd = round((duration_seconds / 3600.0) * HOURLY_RATE_USD, 6)

        k_score = round(
            0.7 * accuracy + 0.3 * min(1.0, trainable / max(1, total) * 10), 4
        )

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
            "target_size": spec_dict["target_size"],
            "device": device,
            "mode": "replicate",
            "trainable_params": trainable,
            "total_params": total,
            "trainable_pct": round(100.0 * trainable / max(1, total), 4),
            "train_seconds": round(train_secs, 3),
            "lora_r": lora_config.r,
            "lora_alpha": lora_config.lora_alpha,
            "lora_targets": list(target_modules),
            "sample_outputs": sample_outputs[:3],
            "backend": "replicate",
            "adapter_sha256": "sha256-" + adapter_sha,
            "adapter_size_bytes": total_bytes,
            "adapter_file_count": file_count,
        }

        receipt = {
            "spec": spec_dict,
            "metrics": metrics,
            "compute": {
                "backend": "replicate",
                "device": f"replicate-{GPU_TYPE}",
                "duration_seconds": round(duration_seconds, 3),
                "cost_usd": cost_usd,
            },
        }
        metrics["receipt_canonical_sha256"] = hashlib.sha256(
            _canonical_json(receipt).encode("utf-8")
        ).hexdigest()

        return {
            "metrics": metrics,
            "adapter_bytes": adapter_b64,
            "adapter_filename": f"{spec_dict['namespace']}.adapter.zip",
            "adapter_format": "peft-lora",
            "device": f"replicate-{GPU_TYPE}",
            "cost_usd": cost_usd,
            "duration_seconds": round(duration_seconds, 3),
        }
