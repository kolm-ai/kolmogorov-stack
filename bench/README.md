# kolm bench reproducer

Reproduces the kolm bench protocol for `kolm bench --reproduce swebench-lite-n150`:

> **Opus-4.7 against baseline on SWE-bench Lite, swebench 4.1.0 evaluator.**
> n=150, seed=42. The headline lift lands here when the first end-to-end
> signed run completes; no point estimate is published before then.

## Two ways to run

### 1. Pinned image (after public launch)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
kolm bench --reproduce swebench-lite-n150 --seed 42 --n 150
```

The CLI pulls `kolm/swebench-reproducer:1.0.0` from Docker Hub and runs the harness with byte-identical evaluator + dependency versions.

Estimated cost: ~$30 in Opus-4.7 spend, ~90 minutes wall-clock. Use `--n 5` for a smoke run (~3 minutes, ~$1).

### 2. Local build (before image lands or for inspection)

```bash
cd bench/
docker build -t kolm/swebench-reproducer:1.0.0 .
ANTHROPIC_API_KEY=sk-ant-... kolm bench --reproduce swebench-lite-n150 --n 5
```

The Dockerfile pins:

- `python==3.11`
- `swebench==4.1.0` (evaluator)
- `anthropic==0.40.0` (model client)
- Dataset: `princeton-nlp/SWE-bench_Lite` at the commit pinned in `run.py`.

## What the harness does

1. **Pass 1 (baseline)** -for each task, single-shot Opus-4.7 with the official SWE-bench prompt. No retrieval, no REM context, no hooks. Records `pass_1_resolved` per task.
2. **Pass 2 (with REM context)** -same task, same model, but the prompt includes (a) the test body for the failing test (parsed from the task spec) and (b) the rewritten retrieve-query for related code snippets. This is the mechanism documented in `articles/rent-vs-buy-compute.html` and `articles/how-we-benchmark.html`.
3. **Evaluation** -every patch is run through swebench 4.1.0's `run_evaluation` to determine pass/fail under the official harness. Strict equality on resolved status.
4. **Report** -outputs `report.json` with:
   - per-task results (id, pass_1_resolved, pass_2_resolved, recovered, regressed)
   - aggregate (pass_1_pct, pass_2_pct, delta_pp, ci_95_low, ci_95_high, p_value)
   - dollar spend (input + output tokens x pinned price card)
   - wall time

## What the protocol measures

The mechanism is **single-turn** -no agent loop, no second model, no tool-calling. The only difference between Pass 1 and Pass 2 is the prompt envelope. This makes the lift attributable to the context injection itself, not to harness ergonomics. The first end-to-end signed run will report `pass_1_pct`, `pass_2_pct`, `delta_pp`, the bootstrap 95% CI on the delta, and a two-tailed Wilcoxon signed-rank test p-value on the per-task resolved deltas. Until that run completes, no point estimate ships here.

## What we do not claim

- No SWE-bench Verified (different distribution, different N, different evaluator settings).
- No multi-shot agent comparison (cursor / claude-code-hooks have their own +pp on top of this; that's a different paper).
- No latency comparison (Pass 2 is ~80-150ms slower because the prompt is ~2k tokens longer; that is fine for the resolved-rate claim).

## Reproducibility expectations

Once the headline signed run lands here, a fresh run on a different machine with `--seed 42 --n 150` should land **within +/-2pp** of it. If your run lands more than +/-2pp off, the most common causes (in order):

1. Anthropic provider returned a different mix of models for some tasks (lock with `anthropic-version: 2023-06-01` and the exact model id `claude-opus-4-7-20251225`).
2. Docker image used pip cache that pulled a newer minor version of `swebench` (the `==4.1.0` pin is exact; if pip resolved 4.1.1, the evaluator differs).
3. n is too small (<50) -the bootstrap CI gets noisy.

If your number disagrees with ours by more than +/-2pp **after** verifying the above, file an issue at https://github.com/kolm/kolm-bench-reproducer/issues with your `report.json` and we will debug.

## Source

The full harness lives at https://github.com/kolm/kolm-bench-reproducer. This directory ships the minimal subset (Dockerfile + run.py + requirements.txt) so operators can build the image without waiting for the public repo to land.
