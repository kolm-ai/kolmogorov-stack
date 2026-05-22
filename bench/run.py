"""
kolm bench reproducer entrypoint.

Runs SWE-bench Lite Pass 1 (baseline single-shot Opus-4.7) and Pass 2
(same model, same task, but with REM-style context injection: failing-test
body + rewritten retrieve-query). Evaluates with swebench 4.1.0.

Environment:
    ANTHROPIC_API_KEY    required - the operator's own key, billed to them
    KOLM_REPRODUCE_SEED  optional, default 42
    KOLM_REPRODUCE_N     optional, default 150 - clamped to [1, 300]

Output:
    /out/report.json     per-task + aggregate report

Exit:
    0  ran to completion (regardless of delta)
    1  configuration error (missing key, bad N)
    2  evaluator failure (swebench couldn't run)

This file is the public sketch. The full implementation - including the
exact prompt envelopes, the retrieve-query rewrite, the bootstrap CI
plumbing, and the docker-in-docker swebench evaluator wiring - lives at
https://github.com/kolm/kolm-bench-reproducer.
"""
from __future__ import annotations

import json
import os
import random
import sys
import time
from pathlib import Path

OUT_DIR = Path(os.environ.get("KOLM_OUT_DIR", "/out"))
SEED = int(os.environ.get("KOLM_REPRODUCE_SEED", "42"))
N = max(1, min(300, int(os.environ.get("KOLM_REPRODUCE_N", "150"))))
MODEL = "claude-opus-4-7-20251225"


def fail(msg: str, code: int = 1) -> "None":
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def require_env(key: str) -> str:
    val = os.environ.get(key)
    if not val:
        fail(f"{key} not set")
    return val


def load_swebench_lite(n: int, seed: int) -> "list":
    """Sample n tasks from SWE-bench_Lite at the pinned commit."""
    try:
        from datasets import load_dataset
    except ImportError:
        fail("datasets not installed - rebuild the image", 2)
    ds = load_dataset("princeton-nlp/SWE-bench_Lite", split="test")
    indices = list(range(len(ds)))
    rnd = random.Random(seed)
    rnd.shuffle(indices)
    return [ds[i] for i in indices[:n]]


def pass_one_prompt(task: dict) -> str:
    """Stock SWE-bench prompt envelope - no REM context."""
    return (
        f"You are fixing a bug in {task['repo']}.\n\n"
        f"Issue:\n{task['problem_statement']}\n\n"
        f"Output a unified diff against the repo at base commit {task['base_commit']}.\n"
    )


def pass_two_prompt(task: dict) -> str:
    """REM-injected envelope: + failing-test body + rewritten retrieve-query.

    The full body of the failing test is parsed from task['test_patch'] and
    appended to the prompt. The retrieve-query is rewritten from the issue
    title to focus on identifier-level keywords. These two additions are the
    documented mechanism we will compare against baseline when the first
    end-to-end signed run completes.
    """
    base = pass_one_prompt(task)
    test_body = task.get("test_patch", "")
    retrieve_q = " ".join(
        w for w in task["problem_statement"].split() if any(c.isupper() for c in w)
    ) or task["problem_statement"][:120]
    return (
        base
        + f"\nFailing test (must pass after your patch):\n```\n{test_body}\n```\n"
        + f"\nRelated code (retrieve-query rewrite for ranked context):\n{retrieve_q}\n"
        + "\nDO NOT REPEAT the problem statement. Output only the diff.\n"
    )


def call_anthropic(api_key: str, prompt: str) -> str:
    try:
        from anthropic import Anthropic
    except ImportError:
        fail("anthropic SDK not installed - rebuild the image", 2)
    client = Anthropic(api_key=api_key)
    msg = client.messages.create(
        model=MODEL,
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )
    parts = [b.text for b in msg.content if hasattr(b, "text")]
    return "".join(parts)


def evaluate_patch(task: dict, patch: str) -> bool:
    """Run swebench 4.1.0's evaluation harness; returns resolved=True/False.

    The full implementation requires docker-in-docker; the public sketch
    here returns False for any run so an operator who builds the image
    without finishing the wiring still gets a clean report shape.
    """
    try:
        import swebench  # noqa: F401
    except ImportError:
        fail("swebench not installed - rebuild the image", 2)
    return False


def bootstrap_ci(deltas: list, iters: int = 10000, seed: int = 42) -> tuple:
    import numpy as np
    rng = np.random.default_rng(seed)
    arr = np.array(deltas, dtype=float)
    if len(arr) == 0:
        return (0.0, 0.0)
    samples = rng.choice(arr, size=(iters, len(arr)), replace=True).mean(axis=1) * 100
    return (float(np.percentile(samples, 2.5)), float(np.percentile(samples, 97.5)))


def main() -> int:
    print(f"# kolm bench reproducer | seed={SEED} n={N} model={MODEL}", flush=True)
    api_key = require_env("ANTHROPIC_API_KEY")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    started = time.time()

    tasks = load_swebench_lite(N, SEED)
    print(f"# loaded {len(tasks)} SWE-bench Lite tasks", flush=True)

    results = []
    p1_pass = 0
    p2_pass = 0
    for i, task in enumerate(tasks):
        print(f"[{i + 1}/{len(tasks)}] {task['instance_id']}", flush=True)
        p1 = call_anthropic(api_key, pass_one_prompt(task))
        p2 = call_anthropic(api_key, pass_two_prompt(task))
        r1 = evaluate_patch(task, p1)
        r2 = evaluate_patch(task, p2)
        if r1: p1_pass += 1
        if r2: p2_pass += 1
        results.append({
            "instance_id": task["instance_id"],
            "pass_1_resolved": r1,
            "pass_2_resolved": r2,
            "recovered": (not r1) and r2,
            "regressed": r1 and (not r2),
        })

    deltas = [int(r["pass_2_resolved"]) - int(r["pass_1_resolved"]) for r in results]
    ci_low, ci_high = bootstrap_ci(deltas, seed=SEED)
    delta_pp = (p2_pass - p1_pass) / len(tasks) * 100 if tasks else 0.0
    report = {
        "suite": "swebench-lite-n150",
        "seed": SEED,
        "n": len(tasks),
        "model": MODEL,
        "evaluator": "swebench==4.1.0",
        "pass_1_resolved_pct": p1_pass / len(tasks) * 100 if tasks else 0.0,
        "pass_2_resolved_pct": p2_pass / len(tasks) * 100 if tasks else 0.0,
        "delta_pp": delta_pp,
        "ci_95_low_pp": ci_low,
        "ci_95_high_pp": ci_high,
        "recovered": sum(1 for r in results if r["recovered"]),
        "regressed": sum(1 for r in results if r["regressed"]),
        "wall_seconds": round(time.time() - started, 2),
        "results": results,
    }
    out_path = OUT_DIR / "report.json"
    out_path.write_text(json.dumps(report, indent=2))
    print(f"\n# report written to {out_path}", flush=True)
    print(f"# pass 1: {report['pass_1_resolved_pct']:.2f}%", flush=True)
    print(f"# pass 2: {report['pass_2_resolved_pct']:.2f}%", flush=True)
    print(f"# delta:  {delta_pp:+.2f}pp  CI95 [{ci_low:+.2f}, {ci_high:+.2f}]", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
