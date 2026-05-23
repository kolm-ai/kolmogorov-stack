"""
apps/runtime/inference_time_scaling.py

W728 orchestrator. Composes best_of_n + self_verify + entropy_budget
behind a single entry point so the CLI (`kolm its ask`) + bench
(`bench/wave728-its-bench.py`) + any in-process caller share the same
flow.

Pipeline:

    1) estimate_entropy(prompt, model_fn)  -> first-token entropy nats
    2) allocate_budget(entropy)            -> {n_samples, verify_rounds}
    3) best_of_n(prompt, n_samples, ...)   -> chosen candidate
    4) self_verify(prompt, candidate,
                   max_retries=verify_rounds) -> verified candidate
    5) return full trace

The orchestrator is intentionally a thin coordinator — every load-
bearing piece of logic (entropy thresholds, scoring fallback, verifier
prompt) lives in the three primitive modules so they remain unit-
testable in isolation. This file just wires them together and shapes
the receipt.

Surface:

    def scale_inference(prompt, model_fn=None) -> dict

Return shape:

    {
        "ok":              bool,
        "version":         "w728-v1",
        "prompt":          str,
        "entropy_nats":    float,
        "budget":          {n_samples, verify_rounds, bucket, reasoning, ...},
        "bon":             {output, all_candidates, scores, chosen_index, n_evaluated},
        "verify":          {final_output, verified, rounds, feedback_trail},
        "final_output":    str,    # mirror of verify.final_output for the JSON consumer
        "model_calls":     int,    # honest count of model_fn invocations
    }

The orchestrator counts ``model_fn`` invocations so the bench can report
cost (calls per prompt). ``model_calls`` is a load-bearing field; the
bench script aggregates over it.
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from apps.runtime.best_of_n import best_of_n
from apps.runtime.entropy_budget import (
    ENTROPY_BUDGET_VERSION,
    allocate_budget,
    estimate_entropy,
)
from apps.runtime.self_verify import self_verify


ITS_ORCHESTRATOR_VERSION: str = "w728-v1"


def _wrap_counter(
    fn: Optional[Callable[..., Any]],
    counter: list[int],
) -> Optional[Callable[..., Any]]:
    """
    Wrap a model_fn so each call bumps a shared counter. ``counter`` is
    a single-element list so the closure can mutate it across the three
    sub-modules (entropy probe + best_of_n + self_verify) without
    threading a state object.
    """
    if fn is None:
        return None

    def _wrapped(*args, **kwargs):
        counter[0] += 1
        return fn(*args, **kwargs)

    return _wrapped


def scale_inference(
    prompt: str,
    model_fn: Optional[Callable[..., Any]] = None,
    base_n: int = 1,
    max_n: int = 8,
) -> dict:
    """
    Run the full W728 inference-time scaling pipeline on ``prompt``.

    ``model_fn`` is passed THROUGH to each of the three sub-modules,
    which means it must accept the union of their calling conventions:
      * estimate_entropy: model_fn(prompt: str) -> probs|dict|float
      * best_of_n:        model_fn(prompt: str, temperature: float) -> str|dict
      * self_verify:      model_fn(prompt: str) -> str|dict

    The cleanest contract is to accept ``(prompt, temperature=None)``
    and inspect args. Tests use deterministic stubs that branch on the
    presence of verify-prompt keywords.
    """
    counter = [0]
    counted_mfn = _wrap_counter(model_fn, counter)

    # Step 1: cheap entropy probe.
    try:
        entropy = estimate_entropy(prompt, model_fn=counted_mfn)
        entropy_error = None
    except Exception as exc:  # pylint: disable=broad-except
        # Honest fallback: if the probe fails, allocate the MID budget
        # (4 samples, 1 verify round) so we don't silently treat a
        # probe failure as "high confidence, ship n=1".
        entropy = 1.0
        entropy_error = f"{type(exc).__name__}: {exc}"

    # Step 2: budget allocation.
    budget = allocate_budget(entropy, base_n=base_n, max_n=max_n)

    # Step 3: best-of-N sampling. Use a moderate temperature for the
    # high/mid buckets; the low bucket short-circuits at n=1 inside
    # best_of_n so the temperature is irrelevant there.
    temperature = 0.0 if budget["n_samples"] == 1 else 0.7

    def _bon_model_fn(p: str, t: float) -> Any:
        # Adapt single-arg model_fn to best_of_n's (prompt, temperature)
        # contract. If the caller's model_fn already accepts a
        # temperature kwarg, threading it via positional preserves both.
        if counted_mfn is None:
            return None
        try:
            return counted_mfn(p, t)
        except TypeError:
            # Caller's model_fn is single-arg (prompt only); fall back.
            return counted_mfn(p)

    bon = best_of_n(
        prompt=prompt,
        n=budget["n_samples"],
        temperature=temperature,
        score_fn=None,
        model_fn=_bon_model_fn,
    )

    # Step 4: self-verification on the best-of-N pick.
    verify = self_verify(
        prompt=prompt,
        candidate=bon["output"],
        model_fn=counted_mfn,
        max_retries=int(budget["verify_rounds"]),
    )

    return {
        "ok": True,
        "version": ITS_ORCHESTRATOR_VERSION,
        "budget_version": ENTROPY_BUDGET_VERSION,
        "prompt": prompt,
        "entropy_nats": float(entropy),
        "entropy_error": entropy_error,
        "budget": budget,
        "bon": bon,
        "verify": verify,
        "final_output": verify["final_output"],
        "final_verified": bool(verify["verified"]),
        "model_calls": int(counter[0]),
    }


__all__ = [
    "scale_inference",
    "ITS_ORCHESTRATOR_VERSION",
]


def _cli_entrypoint() -> int:
    """
    Tiny CLI so the JS dispatcher in cli/kolm.js can spawn this module
    and pipe back JSON. Reads --prompt <text> from argv; emits JSON on
    stdout; non-zero exit on bad args.
    """
    import argparse
    import json
    import sys

    p = argparse.ArgumentParser(prog="python3 -m apps.runtime.inference_time_scaling")
    p.add_argument("--prompt", required=True, help="prompt text to scale")
    p.add_argument("--base-n", type=int, default=1)
    p.add_argument("--max-n", type=int, default=8)
    args = p.parse_args()
    # No real model_fn from the CLI path — the default model_fn in each
    # sub-module emits an honest "[no-model-fn] ..." marker so the JSON
    # consumer can tell it ran a dry-run, not a real inference.
    result = scale_inference(args.prompt, model_fn=None,
                             base_n=args.base_n, max_n=args.max_n)
    sys.stdout.write(json.dumps(result, default=str))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(_cli_entrypoint())
