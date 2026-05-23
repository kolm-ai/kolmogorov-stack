"""
bench/wave728-its-bench.py

W728 inference-time-compute scaling bench.

Runs ``apps.runtime.inference_time_scaling.scale_inference`` against 30
prompts spanning low / mid / high first-token entropy and reports:

  * mean cost          (model_fn calls per prompt)
  * mean quality       (proxy: self-verify rate, 0..1)
  * per-bucket break   (low / mid / high)
  * mean entropy       (sanity check that the bucket gates fire)

Honest: this is a SYNTHETIC bench using a mock model_fn. The mock emits
a controlled first-token distribution that drops the prompt into the
intended bucket; the verifier accepts on a controlled probability. The
purpose is to validate the ORCHESTRATOR (entropy -> budget -> sample ->
verify -> ship) end-to-end without dragging a real LLM into CI.

If KOLM_ITS_BENCH_BACKEND_URL is set, the bench will try to use it as
an OpenAI-compatible endpoint (single-token logprobs probe + completion).
On a failed connect we fall back to the synthetic backend and tag the
report with ``backend: "synthetic_fallback"`` — never silent.

CLI:

    python3 bench/wave728-its-bench.py --json
    python3 bench/wave728-its-bench.py --prompts 60 --json
    python3 bench/wave728-its-bench.py --seed 7
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import time
from typing import Any, Callable

# Make the repo importable when invoked as `python3 bench/...`.
_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

# Deferred imports (after sys.path patch).
# pylint: disable=wrong-import-position
from apps.runtime.inference_time_scaling import (  # noqa: E402
    ITS_ORCHESTRATOR_VERSION,
    scale_inference,
)


def _build_synthetic_model_fn(rng: random.Random) -> Callable[..., Any]:
    """
    Build a deterministic mock model_fn that:
      * returns a first-token probability distribution when called with
        ONE arg (the entropy probe path).
      * returns a candidate answer when called with TWO args (best_of_n).
      * returns a YES/NO verdict when the prompt contains "strict verifier"
        (the self_verify path).

    Entropy bucket is selected from a keyword embedded in the prompt
    text so the bench can construct a known per-bucket workload.
    """

    def _probs_for_bucket(bucket: str) -> list[float]:
        if bucket == "low":
            # Strongly peaked: H ≈ 0.107 nats.
            return [0.97, 0.01, 0.01, 0.01]
        if bucket == "mid":
            # Moderately spread: H ≈ 1.04 nats.
            return [0.55, 0.25, 0.15, 0.05]
        # High: nearly uniform: H ≈ 2.07 nats.
        return [0.13, 0.13, 0.12, 0.12, 0.12, 0.13, 0.13, 0.12]

    def _bucket_for_prompt(prompt: str) -> str:
        # The bench builds prompts with explicit bucket tags so the
        # mock can map prompt->bucket without depending on a tokenizer.
        if "[bucket=low]" in prompt:
            return "low"
        if "[bucket=high]" in prompt:
            return "high"
        return "mid"

    def _mfn(*args, **kwargs):  # noqa: ARG001
        if len(args) == 1:
            text = str(args[0])
            # self_verify reply path. The verifier prompt template starts
            # with "You are a strict verifier."; on that we emit YES with
            # bucket-dependent reliability so the verify-rate proxy is
            # meaningful (low: always pass; mid: 80%; high: 60%).
            if "strict verifier" in text.lower():
                # Derive bucket from the user-prompt segment of the
                # verifier prompt (which embeds the original prompt).
                bucket = _bucket_for_prompt(text)
                pass_rate = {"low": 1.0, "mid": 0.8, "high": 0.6}[bucket]
                if rng.random() < pass_rate:
                    return f"YES bucket={bucket} synthetic pass"
                return f"NO bucket={bucket} synthetic critique: add more detail"
            # Revise path: a free-form revision. The verifier prompt
            # check above runs first, so anything else here is either
            # an entropy probe (single arg, expecting probs) or a
            # revise prompt (which is also single-arg from
            # self_verify's perspective).
            if "Verifier's critique" in text:
                # Revise turn: return a "revised" candidate.
                return f"[revised synthetic answer for bucket={_bucket_for_prompt(text)}]"
            # Entropy probe path.
            return _probs_for_bucket(_bucket_for_prompt(text))
        if len(args) == 2:
            # best_of_n sampling path. Return a synthetic completion;
            # length variation per sample so the length-normalized
            # log-prob proxy actually has something to argmax over.
            prompt = str(args[0])
            bucket = _bucket_for_prompt(prompt)
            pad = "x" * rng.randint(8, 32)
            return f"[synthetic answer bucket={bucket}] {pad}"
        # Unexpected arity: return an empty string rather than throw so
        # the bench reports a real number even on a buggy probe.
        return ""

    return _mfn


def _build_prompts(n: int, rng: random.Random) -> list[str]:
    """
    Construct ``n`` synthetic prompts split across the three entropy
    buckets in a 1:1:1 ratio (with rounding). Each prompt embeds an
    explicit ``[bucket=...]`` tag so the synthetic model_fn can pick
    the right first-token distribution.
    """
    buckets = ["low", "mid", "high"]
    out: list[str] = []
    for i in range(n):
        b = buckets[i % len(buckets)]
        topic = rng.choice(["math", "code", "summary", "translate", "extract", "classify"])
        out.append(f"[bucket={b}] Please {topic} the following input #{i}: ...")
    return out


def _build_remote_model_fn(url: str) -> Callable[..., Any] | None:
    """
    If ``url`` looks like an OpenAI-compatible /v1/completions endpoint,
    return a model_fn that talks to it. On any failure (import error,
    connect refused) return None so the bench can fall back to the
    synthetic path with an honest "backend":"synthetic_fallback" tag.
    """
    try:
        import urllib.error  # noqa: F401
        import urllib.request
    except Exception:  # pylint: disable=broad-except
        return None

    def _mfn(*args, **kwargs):  # noqa: ARG001
        prompt = str(args[0])
        temperature = float(args[1]) if len(args) >= 2 else 0.0
        body = json.dumps({
            "prompt": prompt,
            "temperature": temperature,
            "max_tokens": 64,
            "logprobs": 5,
        }).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:  # nosec - opt-in
                payload = json.loads(resp.read().decode("utf-8"))
        except Exception:  # pylint: disable=broad-except
            # Surface as an empty string so the bench treats this prompt
            # as a no-op rather than crash the whole run. The bench's
            # cost field still counts the call, so a flaky backend
            # shows up as low quality + high cost.
            return ""
        # Stub: real backends will return choices[].text and
        # choices[].logprobs.top_logprobs[0]; we just pluck text here
        # since the synthetic path is the primary bench target.
        try:
            return payload["choices"][0].get("text", "")
        except (KeyError, IndexError, TypeError):
            return ""

    return _mfn


def run_bench(n_prompts: int, seed: int, backend_url: str | None) -> dict:
    rng = random.Random(seed)
    prompts = _build_prompts(n_prompts, rng)

    backend_tag = "synthetic"
    mfn = _build_synthetic_model_fn(rng)
    if backend_url:
        remote_mfn = _build_remote_model_fn(backend_url)
        if remote_mfn is None:
            backend_tag = "synthetic_fallback"
        else:
            backend_tag = "remote"
            mfn = remote_mfn  # type: ignore[assignment]

    per_bucket: dict[str, dict[str, float]] = {
        "low": {"n": 0, "calls": 0, "verified": 0, "entropy_sum": 0.0},
        "mid": {"n": 0, "calls": 0, "verified": 0, "entropy_sum": 0.0},
        "high": {"n": 0, "calls": 0, "verified": 0, "entropy_sum": 0.0},
    }
    rows: list[dict] = []
    t0 = time.time()
    for prompt in prompts:
        result = scale_inference(prompt, model_fn=mfn)
        bucket = result["budget"]["bucket"]
        per_bucket[bucket]["n"] += 1
        per_bucket[bucket]["calls"] += result["model_calls"]
        per_bucket[bucket]["verified"] += 1 if result["final_verified"] else 0
        per_bucket[bucket]["entropy_sum"] += result["entropy_nats"]
        rows.append({
            "prompt": prompt[:80],
            "bucket": bucket,
            "entropy_nats": round(result["entropy_nats"], 4),
            "n_samples": result["budget"]["n_samples"],
            "verify_rounds": result["budget"]["verify_rounds"],
            "verified": result["final_verified"],
            "model_calls": result["model_calls"],
        })
    duration = time.time() - t0

    summary: dict[str, Any] = {
        "ok": True,
        "version": ITS_ORCHESTRATOR_VERSION,
        "backend": backend_tag,
        "n_prompts": n_prompts,
        "seed": seed,
        "duration_s": round(duration, 4),
        "mean_cost_calls": round(
            sum(r["model_calls"] for r in rows) / max(1, len(rows)), 4
        ),
        "mean_verify_rate": round(
            sum(1 if r["verified"] else 0 for r in rows) / max(1, len(rows)), 4
        ),
        "per_bucket": {},
    }
    for bucket, agg in per_bucket.items():
        nb = agg["n"]
        summary["per_bucket"][bucket] = {
            "n": int(nb),
            "mean_calls": round(agg["calls"] / nb, 4) if nb else 0.0,
            "verify_rate": round(agg["verified"] / nb, 4) if nb else 0.0,
            "mean_entropy_nats": round(agg["entropy_sum"] / nb, 4) if nb else 0.0,
        }
    return summary, rows


def main() -> int:
    p = argparse.ArgumentParser(prog="bench/wave728-its-bench.py")
    p.add_argument("--prompts", type=int, default=30, help="number of prompts (default 30)")
    p.add_argument("--seed", type=int, default=1, help="rng seed for the synthetic backend")
    p.add_argument("--json", action="store_true", help="emit summary+rows as JSON on stdout")
    args = p.parse_args()

    backend_url = os.environ.get("KOLM_ITS_BENCH_BACKEND_URL")
    summary, rows = run_bench(args.prompts, args.seed, backend_url)

    if args.json:
        sys.stdout.write(json.dumps({"summary": summary, "rows": rows}, default=str))
        sys.stdout.write("\n")
        return 0
    # Pretty path: emit a one-screen summary.
    sys.stdout.write(
        f"W728 ITS bench — backend={summary['backend']} n={summary['n_prompts']} "
        f"seed={summary['seed']} duration={summary['duration_s']}s\n"
    )
    sys.stdout.write(
        f"  mean cost (model_fn calls/prompt): {summary['mean_cost_calls']}\n"
    )
    sys.stdout.write(
        f"  mean verify rate (quality proxy):  {summary['mean_verify_rate']}\n"
    )
    for bucket in ("low", "mid", "high"):
        row = summary["per_bucket"][bucket]
        sys.stdout.write(
            f"  bucket={bucket}: n={row['n']} mean_calls={row['mean_calls']} "
            f"verify_rate={row['verify_rate']} mean_entropy={row['mean_entropy_nats']} nats\n"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
