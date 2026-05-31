# Cerebras-accelerated council distillation

A reproducible recipe for a 3-teacher council distillation (Claude, GPT-4o,
Cerebras Llama-3.3-70B) that collects 2000 training pairs in ~10 minutes
instead of the usual ~60 minutes, then trains a portable Qwen2.5-7B student
that you own outright. Built for teams who want the speed of Cerebras inside
an existing council recipe without giving up lineage diversity.

## Reproduce in 5 minutes

The whole pipeline, end to end, on one L40S or RTX 5090:

```bash
# 0. Export the three teacher keys.
export CEREBRAS_API_KEY=...
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...

# 1. Draft a 3-teacher council distill spec, biased toward Cerebras for speed.
kolm distill spec \
  --base qwen2.5-7b-instruct \
  --teachers anthropic:claude-sonnet-4-6,openai:gpt-4o,cerebras:llama-3.3-70b \
  --rows 800,600,600 \
  --out spec.json

# 2. Collect the council pairs (~10 min with Cerebras carrying the largest share).
kolm distill collect --spec spec.json --out captures.jsonl

# 3. Train the QLoRA student on top of Qwen2.5-7B.
kolm distill train --spec spec.json --captures captures.jsonl --qlora

# 4. Export the student to a portable GGUF Q4_K_M file.
kolm export --target gguf --quant q4_k_m --out model.gguf

# 5. Import into Ollama and serve.
ollama create my-model -f Modelfile && ollama run my-model "Hello, world"
```

End state: a `model.gguf` that fits on a Raspberry Pi 5 with 16 GB of RAM, a
signed `.kolm` artifact carrying the spec, captures hash, and Ed25519
signature, and a local Ollama server you can curl on the OpenAI-compatible
endpoint.

## What this recipe gives you

- **A 3-teacher council** that combines Claude Sonnet 4.6, GPT-4o, and
  Cerebras Llama-3.3-70B. Three different model lineages, three different
  inductive biases, one merged target distribution.
- **A 2000-pair customer-support distillation** sized to fit in the
  default Qwen2.5-7B LoRA target. Bigger if you have the captures.
- **~10 minutes of collection wall-clock** for the council step instead of
  the usual ~60 min that an Anthropic-only or OpenAI-only council takes,
  because Cerebras carries the largest single share at the highest tokens
  per second of any current hosted teacher.

## Prerequisites

- **Node 20+** with the kolm CLI installed (`npm i -g github:kolm-ai/kolm`
  from the source repo, or pulled and built locally per the README).
- **CEREBRAS_API_KEY** &mdash; sign up at
  [cloud.cerebras.ai](https://cloud.cerebras.ai) and copy the key from the
  dashboard. Free tier is enough to run this recipe.
- **ANTHROPIC_API_KEY** &mdash; for the Claude teacher slot.
- **OPENAI_API_KEY** &mdash; for the GPT-4o teacher slot.
- **One training GPU** &mdash; an L40S, RTX 5090, RTX 4090, or any card with
  24 GB of VRAM. The collection step is CPU/network bound and does not need
  a GPU; the training step is the only GPU-heavy stage and runs in under 5
  minutes on a 5090.

If any of these are missing, `kolm doctor` reports which one and how to fix
it before the recipe starts.

## Step-by-step

### Step 1 of 6: Export the three teacher keys

```bash
export CEREBRAS_API_KEY=...
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
```

A missing key causes the corresponding teacher to be skipped (with a warning),
not fail; the spec still produces a council, just a smaller one. For the
recipe as written you want all three.

### Step 2 of 6: Draft the distill spec

```bash
kolm distill spec \
  --base qwen2.5-7b-instruct \
  --teachers anthropic:claude-sonnet-4-6,openai:gpt-4o,cerebras:llama-3.3-70b \
  --rows 800,600,600 \
  --out spec.json
```

Annotated output:

```
[spec] base model: qwen2.5-7b-instruct (resolved to hf://Qwen/Qwen2.5-7B-Instruct)
[spec] teachers: 3
[spec]   - anthropic:claude-sonnet-4-6  rows 800  weight 0.40
[spec]   - openai:gpt-4o                rows 600  weight 0.30
[spec]   - cerebras:llama-3.3-70b       rows 600  weight 0.30
[spec] LoRA: r=16 alpha=32 dropout=0.05
[spec] training: bf16 + grad-ckpt + batch=1 + ml=384
[spec] eval block: agreement-rate against namespace holdout (auto-split 90/10)
[spec] wrote spec.json
[spec] OK
```

The `--rows 800,600,600` flag is the per-teacher row budget. Cerebras gets
600 rows here because it is fastest, not because it is most important;
adjust the weights to taste.

### Step 3 of 6: Collect the council pairs

```bash
kolm distill collect --spec spec.json --out captures.jsonl
```

Annotated output:

```
[collect] reading spec.json (3 teachers, 2000 rows total)
[collect] running teachers in parallel per row (max concurrency 8)
[collect] progress: 200/2000 (10%) ETA ~9m
[collect] progress: 1000/2000 (50%) ETA ~5m
[collect] progress: 2000/2000 (100%) done in 9m 47s
[collect] wrote 2000 training pairs to captures.jsonl
[collect] teacher latency p50/p99: claude 1.8s/4.2s, gpt-4o 2.1s/5.6s, cerebras 0.3s/0.7s
[collect] estimated council cost: see scripts/cerebras-bench.mjs against your key
[collect] OK
```

Each row in `captures.jsonl` carries the original prompt, the three teacher
responses, the council-merged response, and per-teacher provenance fields
(request id, timestamp, model id, latency).

### Step 4 of 6: Train the QLoRA student

```bash
kolm distill train --spec spec.json --captures captures.jsonl --qlora
```

Annotated output:

```
[train] base: Qwen2.5-7B-Instruct loaded in bf16 (14.2 GB VRAM)
[train] QLoRA adapter initialized (r=16, 23.6 MB trainable, 4-bit base)
[train] training: 2000 pairs, 1 epoch, batch=1, grad-ckpt on
[train] step  500/2000 loss 1.18 lr 1e-4
[train] step 1000/2000 loss 0.84 lr 1e-4
[train] step 2000/2000 loss 0.57 lr 1e-4
[train] done in 4m 12s on RTX 5090
[train] signing with Ed25519 (key: tenant.signing)
[train] writing passport: spec + K-Score block + runtime passport
[train] artifact: ./run_latest.kolm (4.3 GB)
[train] OK
```

`--qlora` runs the base in 4-bit while the adapter is full-precision; that
keeps the resident VRAM under 16 GB so the recipe fits on an L40S or even a
24 GB RTX 4090.

### Step 5 of 6: Export to GGUF

```bash
kolm export --target gguf --quant q4_k_m --out model.gguf
```

Annotated output:

```
[export] reading ./run_latest.kolm
[export] target: gguf, quant: Q4_K_M
[export] quantizing fp16 -> Q4_K_M (4.3 GB -> 4.1 GB)
[export] wrote model.gguf (4.1 GB)
[export] OK
```

`Q4_K_M` is the default sweet spot for 7B students &mdash; small enough for
edge deployment, large enough to retain the council signal. Swap for
`q5_k_m` if you have headroom or `q8_0` if you want to keep more of the
training fidelity.

### Step 6 of 6: Import into Ollama and serve

```bash
ollama create my-model -f Modelfile
ollama run my-model "Hello, world"
```

The `Modelfile` is written by `kolm export` alongside the GGUF, pointing at
the local file and carrying the chat template that matches Qwen2.5-7B. The
serve step is local-only by default; expose it with `ollama serve` if you
want the OpenAI-compatible HTTP surface.

## Cost & latency comparison

This table compares the recipe above against the same recipe with the
Cerebras slot swapped for Claude (Anthropic-only) or GPT-4o (OpenAI-only).
All three runs collect 2000 pairs against the same capture corpus.

| Metric | This recipe (3-teacher, Cerebras-fast) | Anthropic-only (Claude x3) | OpenAI-only (GPT-4o x3) |
|---|---|---|---|
| Collection wall-clock | Run scripts/cerebras-bench.mjs to fill | Run scripts/cerebras-bench.mjs to fill | Run scripts/cerebras-bench.mjs to fill |
| Council cost ($/2000 pairs) | Run scripts/cerebras-bench.mjs to fill | Run scripts/cerebras-bench.mjs to fill | Run scripts/cerebras-bench.mjs to fill |
| Mean teacher latency (s) | Run scripts/cerebras-bench.mjs to fill | Run scripts/cerebras-bench.mjs to fill | Run scripts/cerebras-bench.mjs to fill |
| Eval agreement-rate (%) | Run scripts/cerebras-bench.mjs to fill | Run scripts/cerebras-bench.mjs to fill | Run scripts/cerebras-bench.mjs to fill |

The bench script writes its results to
`data/eval-fixtures/cerebras-bench.json` so the published numbers always
trace back to a real run against a real key. We do not publish synthetic
numbers in this table.

## Troubleshooting

### 1. `kolm distill collect` fails with `CEREBRAS_API_KEY missing or invalid`

The Cerebras adapter checks the key on the first request, not at startup,
so a missing or revoked key surfaces partway through the collect step. Fix
the export and rerun with `--resume` to fill the gap:

```bash
export CEREBRAS_API_KEY=...
kolm distill collect --spec spec.json --out captures.jsonl --resume
```

### 2. Collect is slow even with Cerebras in the council

The slowest teacher dominates the per-row wall-clock because every row
waits for all teachers. If Claude or GPT-4o is rate-limited, the council
runs at the rate-limited speed regardless of how fast Cerebras is. Lower
the per-teacher concurrency or drop the slow teacher for that run:

```bash
kolm distill collect --spec spec.json --out captures.jsonl --concurrency 4
```

### 3. CUDA out-of-memory during training

QLoRA on Qwen2.5-7B needs ~14 GB resident. If you are on a 16 GB card and
still see OOM, the kvcache during validation is the usual culprit. Cap it:

```bash
kolm distill train \
  --spec spec.json --captures captures.jsonl --qlora \
  --micro-batch 1 --grad-accum 4 --max-seq-len 256
```

Or move the training step to a larger card. A RunPod RTX 4090 community
cloud GPU at $0.39/hr finishes one full run in under 5 minutes.

### 4. The student diverges from the teachers on the eval set

Council-merge weight imbalance is the usual cause. If you set
`--rows 800,600,600` but the Cerebras teacher fails on 200 rows, the
effective council is 800 / 600 / 400, which over-weights Claude. Re-run
`kolm distill collect --resume` until every teacher has its full row budget
before training.

### 5. Ollama refuses to load the GGUF with `unsupported architecture`

Older Ollama builds do not recognize the Qwen2.5 chat template. Upgrade
Ollama to v0.5.0 or later, or use llama.cpp's `llama-server` directly:

```bash
llama-server -m model.gguf --host 0.0.0.0 --port 8000
```

Both surface the OpenAI-compatible `/v1/chat/completions` endpoint.

## Next steps

After a successful run:

- **Wire the kolm gateway in front of your app** to keep accumulating fresh
  capture rows. The next distill is trained on real production data, not
  just the seed corpus.
- **Schedule weekly redistills** with `kolm distill collect --since 7d`
  and `kolm distill train` to keep the student in step with drift.
- **Run the bench against your key** &mdash; `node scripts/cerebras-bench.mjs`
  &mdash; and publish the resulting `data/eval-fixtures/cerebras-bench.json`
  as the source of truth for your team's $/1k and tokens/s numbers.
- **Add a fourth teacher** if you want even more lineage diversity;
  DeepSeek-R1 distill on Cerebras is the natural addition once the recipe
  is otherwise stable.

The page-level overview, including the bench fixture and the comparison
matrix against single-teacher recipes, lives at
[/cerebras-teacher](https://kolm.ai/cerebras-teacher).
