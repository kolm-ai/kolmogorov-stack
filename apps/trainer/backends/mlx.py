"""local-mlx backend. Native LoRA training on Apple Silicon via mlx_lm.

This is the real MLX-native path that supersedes the torch-MPS fallback in
``backends/local.py``. It uses ``mlx_lm.lora`` (Apple's first-party LoRA
trainer, separate from PEFT) and re-exports the resulting adapter in a
PEFT-compatible safetensors layout so the verifier and the JS runtime can
load it identically to anything produced by the CUDA/CPU paths.

Required deps (install on the user's box, not in the Modal/Render image):
  pip install mlx mlx_lm safetensors httpx

Env vars:
  KOLM_LOCAL_BASE_MODEL    HF model id; defaults to ``sshleifer/tiny-gpt2``.
                            For real Apple Silicon training pass an MLX-
                            compatible repo such as
                            ``mlx-community/Qwen2.5-0.5B-Instruct-4bit``.
  KOLM_MLX_EPOCHS          training epochs, default 1
  KOLM_MLX_LORA_RANK       LoRA rank, default 8
  KOLM_MLX_LORA_LAYERS     number of last transformer blocks to wrap, default 8
  KOLM_MLX_BATCH_SIZE      micro-batch size, default 2
  KOLM_MLX_LR              learning rate, default 5e-4
  KOLM_MLX_MAX_SEQ_LEN     max sequence length, default 256

Install hint on failure: https://github.com/ml-explore/mlx-examples (LoRA)
and https://pypi.org/project/mlx-lm/

Caveat: mlx_lm's training entry point exposes a programmatic ``train``
function (mlx_lm.tuner.trainer.train) that takes its own ``TrainingArgs``
dataclass and an iterator-style dataset. The corpus format expected is one
JSONL row per example with a ``text`` field (or ``prompt`` + ``completion``
which mlx_lm concatenates with a newline). We normalize the kolm corpus
(``{prompt, completion}``) to mlx_lm's shape on the fly.

Caveat 2: mlx_lm writes adapters as ``adapters.safetensors`` with module
names like ``model.layers.N.self_attn.{q,k,v,o}_proj.lora_A``. We rewrite
those keys to the PEFT canonical layout
``base_model.model.model.layers.N.self_attn.q_proj.lora_A.weight`` and emit
an ``adapter_config.json`` so peft.PeftModel.from_pretrained loads the
adapter directly.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any, Callable


INSTALL_HINT = (
    "install with `pip install mlx mlx_lm safetensors` on Apple Silicon. "
    "See https://github.com/ml-explore/mlx-examples for the LoRA examples."
)

DEFAULT_MLX_MODEL = os.environ.get("KOLM_LOCAL_BASE_MODEL", "sshleifer/tiny-gpt2")
_MAX_PAIRS = 50000


def _verify_imports() -> tuple[Any, Any]:
    try:
        import mlx  # noqa: F401
        import mlx_lm  # noqa: F401
    except ImportError as err:
        raise RuntimeError(f"local-mlx: mlx + mlx_lm not importable ({err}). {INSTALL_HINT}") from err
    import mlx
    import mlx_lm
    return mlx, mlx_lm


def _validate_job(job) -> None:
    url = (job.corpus_url or "").strip()
    if not url:
        raise ValueError("local-mlx: corpus_url required")
    if not (url.startswith("https://") or url.startswith("file://")):
        raise ValueError("local-mlx: corpus_url must be https or file URL")
    if int(job.pair_count or 0) > _MAX_PAIRS:
        raise ValueError(f"local-mlx: pair_count {job.pair_count} exceeds cap {_MAX_PAIRS}")


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


def _to_mlx_jsonl(pairs: list[dict[str, str]], dest: Path) -> None:
    """mlx_lm expects JSONL rows with a ``text`` field per row.

    We render each pair as ``prompt\\ncompletion`` to match the trainer_local
    SFT contract: same target as the torch path, just a different
    serialization key.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("w", encoding="utf-8") as fh:
        for ex in pairs:
            text = (ex["prompt"] + "\n" + ex["completion"]).strip()
            if not text:
                continue
            fh.write(json.dumps({"text": text}, ensure_ascii=False) + "\n")


def _resolve_base_model(job) -> str:
    bm = (getattr(job, "base_model", "") or "").strip()
    if not bm or bm.endswith("-q4_0") or "unsloth" in bm.lower() or "_q4" in bm.lower():
        return DEFAULT_MLX_MODEL
    return bm


def _rewrite_mlx_adapter_to_peft(mlx_safetensors_path: Path, out_dir: Path, base_model_id: str, lora_rank: int) -> None:
    """Convert mlx_lm's adapters.safetensors → peft-canonical layout.

    mlx_lm keys look like ``model.layers.0.self_attn.q_proj.lora_a.weight``
    (lowercase a/b). PEFT expects ``base_model.model.<original>.lora_A.weight``
    and ``.lora_B.weight``. We also emit a minimal ``adapter_config.json``
    so the JS runtime + verifier can load it through the same code path as
    every other backend's output.
    """
    from safetensors import safe_open
    from safetensors.torch import save_file
    import torch

    rewritten: dict[str, "torch.Tensor"] = {}
    with safe_open(str(mlx_safetensors_path), framework="pt") as f:
        for key in f.keys():
            tensor = f.get_tensor(key)
            if not isinstance(tensor, torch.Tensor):
                tensor = torch.as_tensor(tensor)
            new_key = key
            # Normalize lora_a → lora_A.weight, lora_b → lora_B.weight.
            for src, dst in (("lora_a.weight", "lora_A.weight"),
                             ("lora_b.weight", "lora_B.weight"),
                             ("lora_a", "lora_A.weight"),
                             ("lora_b", "lora_B.weight")):
                if new_key.endswith(src):
                    new_key = new_key[: -len(src)] + dst
                    break
            # Prepend PEFT scope.
            if not new_key.startswith("base_model.model."):
                new_key = "base_model.model." + new_key
            rewritten[new_key] = tensor.contiguous()

    out_dir.mkdir(parents=True, exist_ok=True)
    save_file(rewritten, str(out_dir / "adapter_model.safetensors"))

    adapter_config = {
        "base_model_name_or_path": base_model_id,
        "bias": "none",
        "lora_alpha": int(lora_rank * 2),
        "lora_dropout": 0.05,
        "peft_type": "LORA",
        "r": int(lora_rank),
        "target_modules": ["q_proj", "k_proj", "v_proj", "o_proj"],
        "task_type": "CAUSAL_LM",
    }
    (out_dir / "adapter_config.json").write_text(json.dumps(adapter_config, indent=2), encoding="utf-8")


def _hash_adapter_dir(out_dir: Path) -> tuple[str, int, int]:
    hasher = hashlib.sha256()
    total = 0
    count = 0
    for fp in sorted(out_dir.rglob("*")):
        if not fp.is_file():
            continue
        if "_mlx_scratch" in fp.parts:
            continue
        rel = fp.relative_to(out_dir).as_posix().encode("utf-8")
        data = fp.read_bytes()
        hasher.update(rel)
        hasher.update(b"\x00")
        hasher.update(data)
        total += len(data)
        count += 1
    return hasher.hexdigest(), total, count


def _gpu_name(mlx) -> str:
    try:
        info = mlx.core.metal.device_info()
        return str(info.get("device_name", "apple-silicon"))
    except Exception:
        return "apple-silicon"


async def _run_mlx_training(job, out_dir: Path, train_jsonl: Path, valid_jsonl: Path, base_model_id: str, on_progress) -> dict[str, Any]:
    """Drive mlx_lm.lora training. Returns the metrics dict."""
    mlx, mlx_lm = _verify_imports()

    from mlx_lm import load as mlx_load
    from mlx_lm.tuner.trainer import TrainingArgs, train as mlx_train
    from mlx_lm.tuner.utils import linear_to_lora_layers
    from mlx_lm.tuner.datasets import CompletionsDataset
    import mlx.optimizers as optim

    on_progress("loading_model", 20)
    model, tokenizer = mlx_load(base_model_id)

    on_progress("attaching_lora", 35)
    lora_rank = int(os.environ.get("KOLM_MLX_LORA_RANK", "8"))
    lora_layers = int(os.environ.get("KOLM_MLX_LORA_LAYERS", "8"))
    model.freeze()
    linear_to_lora_layers(
        model,
        num_layers=lora_layers,
        config={"rank": lora_rank, "alpha": lora_rank * 2, "dropout": 0.05},
    )

    on_progress("training", 50)
    scratch = out_dir / "_mlx_scratch"
    scratch.mkdir(parents=True, exist_ok=True)
    adapter_path = scratch / "adapters.safetensors"

    args = TrainingArgs(
        batch_size=int(os.environ.get("KOLM_MLX_BATCH_SIZE", "2")),
        iters=int(os.environ.get("KOLM_MLX_ITERS", "100")),
        val_batches=1,
        steps_per_report=5,
        steps_per_eval=50,
        steps_per_save=100,
        adapter_file=str(adapter_path),
        max_seq_length=int(os.environ.get("KOLM_MLX_MAX_SEQ_LEN", "256")),
        grad_checkpoint=False,
    )

    train_ds = CompletionsDataset(
        data=[json.loads(line) for line in train_jsonl.read_text(encoding="utf-8").splitlines() if line.strip()],
        tokenizer=tokenizer,
    )
    valid_ds = CompletionsDataset(
        data=[json.loads(line) for line in valid_jsonl.read_text(encoding="utf-8").splitlines() if line.strip()],
        tokenizer=tokenizer,
    )

    optimizer = optim.AdamW(learning_rate=float(os.environ.get("KOLM_MLX_LR", "5e-4")))

    t0 = time.time()
    train_info = mlx_train(
        model=model,
        tokenizer=tokenizer,
        optimizer=optimizer,
        train_dataset=train_ds,
        val_dataset=valid_ds,
        args=args,
    )
    train_secs = time.time() - t0

    on_progress("packaging_adapter", 90)
    final_loss = float(getattr(train_info, "train_loss", 0.0) or 0.0)
    _rewrite_mlx_adapter_to_peft(adapter_path, out_dir, base_model_id, lora_rank)

    return {
        "train_loss_final": final_loss,
        "train_seconds": round(train_secs, 3),
        "iters": args.iters,
        "lora_r": lora_rank,
        "lora_alpha": lora_rank * 2,
        "lora_layers": lora_layers,
    }


async def run(job, adapter_dir: Path, on_progress: Callable[[str, int], None]) -> dict[str, Any]:
    mlx, mlx_lm = _verify_imports()
    _validate_job(job)

    started_at = time.time()
    base_model_id = _resolve_base_model(job)

    on_progress("loading_corpus", 5)
    pairs = await _load_corpus(job)
    if not pairs:
        raise ValueError("local-mlx: corpus is empty (expected JSONL of {prompt, completion})")

    holdout_n = max(1, int(len(pairs) * (job.holdout_ratio or 0.1)))
    train_pairs = pairs[:-holdout_n]
    eval_pairs = pairs[-holdout_n:]

    out_dir = adapter_dir / job.job_id
    out_dir.mkdir(parents=True, exist_ok=True)

    train_jsonl = out_dir / "_mlx_scratch" / "train.jsonl"
    valid_jsonl = out_dir / "_mlx_scratch" / "valid.jsonl"
    _to_mlx_jsonl(train_pairs, train_jsonl)
    _to_mlx_jsonl(eval_pairs, valid_jsonl)

    train_stats = await _run_mlx_training(
        job, out_dir, train_jsonl, valid_jsonl, base_model_id, on_progress
    )

    adapter_sha, total_bytes, file_count = _hash_adapter_dir(out_dir)
    finished_at = time.time()

    on_progress("complete", 100)
    return {
        "metrics": {
            "pair_count": len(pairs),
            "holdout_pair_count": holdout_n,
            "holdout_accuracy": 0.0,
            "training_loss_final": train_stats["train_loss_final"],
            "epochs": int(os.environ.get("KOLM_MLX_EPOCHS", "1")),
            "steps": train_stats["iters"],
            "base_model": base_model_id,
            "target_size": job.target_size,
            "device": "apple-silicon-mlx",
            "mode": "local-mlx",
            "train_seconds": train_stats["train_seconds"],
            "lora_r": train_stats["lora_r"],
            "lora_alpha": train_stats["lora_alpha"],
            "lora_layers": train_stats["lora_layers"],
            "lora_targets": ["q_proj", "k_proj", "v_proj", "o_proj"],
        },
        "adapter": {
            "url": f"file://{out_dir.resolve().as_posix()}",
            "sha256": "sha256-" + adapter_sha,
            "size_bytes": total_bytes,
            "file_count": file_count,
            "format": "peft-lora",
        },
        "compute": {
            "backend": "local-mlx",
            "device": "apple-silicon-mlx",
            "cost_usd": 0.0,
            "started_at": started_at,
            "finished_at": finished_at,
            "duration_seconds": round(finished_at - started_at, 3),
            "provenance": {
                "framework": "mlx_lm",
                "mlx_version": getattr(mlx, "__version__", "unknown"),
                "mlx_lm_version": getattr(mlx_lm, "__version__", "unknown"),
                "gpu_name": _gpu_name(mlx),
                "base_model": base_model_id,
            },
        },
    }
