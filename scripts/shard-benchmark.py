#!/usr/bin/env python3
# scripts/shard-benchmark.py
#
# Real Python smoke that benchmarks the default HuggingFace KV cache against
# the Shard KV cache on Qwen2.5-0.5B-Instruct (smallest viable RoPE model).
#
# Measures (per cache):
#   * peak VRAM (bytes, via torch.cuda.max_memory_allocated)
#   * tokens/sec (steady-state decode)
#   * output text (for similarity comparison)
#
# Exit codes:
#   0  - both cache paths ran; JSON envelope on stdout with results
#   2  - bad arguments
#   3  - dependency missing (torch / transformers / shard); JSON envelope
#        on stdout with ok:false, reason:'shard_not_installed' (or similar)
#
# Usage:
#   python scripts/shard-benchmark.py \
#       --model Qwen/Qwen2.5-0.5B-Instruct \
#       --prompt-tokens 2048 \
#       --max-new-tokens 64
#
# Output: single JSON document on stdout, one line.
#
# Caveats:
#   * Requires a CUDA GPU. CPU run yields zero VRAM and meaningless tok/s.
#   * Similarity ratio uses character-level overlap (cheap, not semantic).
#     For real quality validation use the kolm benchmark suite.

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone


def _envelope(**kwargs) -> str:
    """Single-line JSON envelope for stdout."""
    return json.dumps(kwargs, separators=(",", ":"))


def _emit_and_exit(code: int, **payload) -> None:
    """Print one JSON line on stdout and exit with code."""
    sys.stdout.write(_envelope(**payload) + "\n")
    sys.stdout.flush()
    sys.exit(code)


def _similarity_ratio(a: str, b: str) -> float:
    """Cheap character-overlap similarity in [0.0, 1.0]."""
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    matches = sum(1 for c in short if c in long_)
    return matches / max(1, len(long_))


def benchmark_cache(
    model,
    tokenizer,
    cache_obj,
    prompt_tokens: int,
    max_new_tokens: int,
    torch_mod,
):
    """Run one decode pass with the supplied cache and return measurements."""
    device = next(model.parameters()).device
    prompt_text = "Tell me a long story. " * max(1, prompt_tokens // 5)
    enc = tokenizer(prompt_text, return_tensors="pt", truncation=True, max_length=prompt_tokens)
    input_ids = enc["input_ids"].to(device)

    if torch_mod.cuda.is_available():
        torch_mod.cuda.empty_cache()
        torch_mod.cuda.reset_peak_memory_stats()

    gen_kwargs = {
        "max_new_tokens": max_new_tokens,
        "do_sample": False,
        "pad_token_id": tokenizer.eos_token_id,
    }
    if cache_obj is not None:
        gen_kwargs["past_key_values"] = cache_obj

    t0 = time.perf_counter()
    with torch_mod.inference_mode():
        out = model.generate(input_ids, **gen_kwargs)
    elapsed = time.perf_counter() - t0

    new_tokens = out.shape[-1] - input_ids.shape[-1]
    tok_s = new_tokens / elapsed if elapsed > 0 else 0.0
    text = tokenizer.decode(out[0, input_ids.shape[-1]:], skip_special_tokens=True)
    peak_vram_bytes = (
        torch_mod.cuda.max_memory_allocated()
        if torch_mod.cuda.is_available()
        else 0
    )

    return {
        "tok_s": float(tok_s),
        "elapsed_s": float(elapsed),
        "new_tokens": int(new_tokens),
        "peak_vram_bytes": int(peak_vram_bytes),
        "output_text": text[:512],
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Benchmark default HF Cache vs Shard KV cache."
    )
    parser.add_argument("--model", default="Qwen/Qwen2.5-0.5B-Instruct")
    parser.add_argument("--prompt-tokens", type=int, default=2048)
    parser.add_argument("--max-new-tokens", type=int, default=64)
    args = parser.parse_args(argv)

    # Dependency probes — exit 3 with envelope on import failure.
    try:
        import torch  # type: ignore
    except ImportError:
        _emit_and_exit(
            3,
            ok=False,
            reason="torch_not_installed",
            hint="pip install torch",
        )

    try:
        from transformers import AutoModelForCausalLM, AutoTokenizer  # type: ignore
    except ImportError:
        _emit_and_exit(
            3,
            ok=False,
            reason="transformers_not_installed",
            hint="pip install transformers",
        )

    try:
        from shard import ShardCache  # type: ignore
    except ImportError:
        _emit_and_exit(
            3,
            ok=False,
            reason="shard_not_installed",
            hint="pip install shard-kv",
            note="See github.com/krish1905/shard",
        )

    if not torch.cuda.is_available():
        _emit_and_exit(
            3,
            ok=False,
            reason="cuda_unavailable",
            hint="Shard benchmark requires a CUDA GPU.",
        )

    # Load model + tokenizer.
    try:
        tokenizer = AutoTokenizer.from_pretrained(args.model)
        model = AutoModelForCausalLM.from_pretrained(
            args.model, torch_dtype=torch.float16
        ).to("cuda")
    except Exception as exc:  # noqa: BLE001 - we want any failure to surface
        _emit_and_exit(
            3,
            ok=False,
            reason="model_load_failed",
            hint=f"Could not load {args.model}: {exc!r}",
        )

    # Default HF Cache run (cache_obj=None -> transformers builds default).
    default_run = benchmark_cache(
        model=model,
        tokenizer=tokenizer,
        cache_obj=None,
        prompt_tokens=args.prompt_tokens,
        max_new_tokens=args.max_new_tokens,
        torch_mod=torch,
    )

    # Shard run.
    try:
        shard_cache = ShardCache(model.config)
    except Exception as exc:  # noqa: BLE001
        _emit_and_exit(
            3,
            ok=False,
            reason="shard_cache_init_failed",
            hint=f"ShardCache(config) raised: {exc!r}",
            default_run=default_run,
        )

    shard_run = benchmark_cache(
        model=model,
        tokenizer=tokenizer,
        cache_obj=shard_cache,
        prompt_tokens=args.prompt_tokens,
        max_new_tokens=args.max_new_tokens,
        torch_mod=torch,
    )

    compression = (
        default_run["peak_vram_bytes"] / shard_run["peak_vram_bytes"]
        if shard_run["peak_vram_bytes"] > 0
        else 0.0
    )
    similarity = _similarity_ratio(default_run["output_text"], shard_run["output_text"])

    print(
        _envelope(
            ok=True,
            ran_at=datetime.now(timezone.utc).isoformat(),
            model=args.model,
            prompt_tokens=args.prompt_tokens,
            max_new_tokens=args.max_new_tokens,
            results={
                "default": default_run,
                "shard": shard_run,
            },
            compression_ratio=float(compression),
            similarity_ratio=float(similarity),
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
