# OpenAI fine-tuning -> kolm migration

A reproducible six-command migration from an OpenAI fine-tuning dataset
(`fine_tuning_data.jsonl`) to a portable, signed kolm artifact that runs on
your GPU or any cloud GPU. Built for the January 2027 OpenAI fine-tuning
sunset; usable today.

## Reproduce in 5 minutes

The whole pipeline, end to end, assuming the CLI is already installed and a
`fine_tuning_data.jsonl` exists in the current directory:

```bash
# 1. Import the OpenAI fine-tuning dataset into a kolm capture lake
kolm import --from openai-finetune ./fine_tuning_data.jsonl \
  --out ./captures.jsonl \
  --namespace support

# 2. Generate the distill spec (which teachers, which base, which hyperparams)
kolm distill spec \
  --namespace support \
  --base qwen2.5-7b-instruct \
  --teachers claude-opus-4-7,gpt-4o,cerebras:llama-3.3-70b \
  --output ./distill-spec.json

# 3. Run the council teachers across the imported captures
kolm distill collect \
  --spec ./distill-spec.json \
  --captures ./captures.jsonl \
  --out ./training-pairs.jsonl

# 4. Train the student model (LoRA on Qwen2.5-7B, signs the artifact)
kolm distill train \
  --spec ./distill-spec.json \
  --pairs ./training-pairs.jsonl \
  --out ./support-v1.kolm

# 5. Evaluate parity against the OpenAI fine-tuning baseline
kolm eval \
  --artifact ./support-v1.kolm \
  --baseline-jsonl ./fine_tuning_data.jsonl \
  --metric agreement-rate \
  --out ./eval-report.json

# 6. Deploy to one or more targets (vLLM server, GGUF for edge, Ollama)
kolm deploy ./support-v1.kolm \
  --target vllm \
  --target gguf-q4km \
  --target ollama
```

End state: a signed `.kolm` artifact, an eval report comparing it to the OpenAI
baseline, and three deployment surfaces ready to serve OpenAI-compatible
`/v1/chat/completions`.

## What this recipe assumes

- You have a working (or until-recently-working) OpenAI fine-tuning job and
  the `fine_tuning_data.jsonl` dataset you trained it on. Both the
  chat-completions format (`{"messages":[...]}`) and the legacy completions
  format (`{"prompt":..., "completion":...}`) are supported.
- You have GPU access: a local card with 16 GB+ of VRAM (a 4090 or 5090
  works), or willingness to rent a $0.39/hr RunPod RTX 4090 community-cloud
  GPU for the training step. The other steps are CPU-bound.
- You have API keys for the council teachers exported as environment
  variables: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `CEREBRAS_API_KEY`.
  Missing keys cause the corresponding teacher to be skipped (with a warning),
  not fail; the spec still produces a council, just a smaller one.
- You have the kolm CLI installed (`npm i -g github:kolm-ai/kolm` from the
  source repo, or pulled and built locally per the README).

If any of these are missing, `kolm doctor` reports which one and how to fix
it before you start the migration.

## Step-by-step

### Step 1 of 6: Import

```bash
kolm import --from openai-finetune ./fine_tuning_data.jsonl \
  --out ./captures.jsonl \
  --namespace support
```

Annotated output:

```
[import] reading ./fine_tuning_data.jsonl
[import] detected format: chat-completions (1000 rows scanned)
[import] parsed 998 rows, skipped 2 malformed (see ./captures.jsonl.errors)
[import] wrote 998 capture rows to ./captures.jsonl
[import] namespace: support
[import] OK
```

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | Success. `captures.jsonl` written. |
| 2 | Bad arguments. Missing `--from`, missing input path, etc. |
| 3 | Input file not found or unreadable. |
| 4 | Parse-error rate exceeded the safety threshold (default: 5% of rows). |

Common failure modes:

- **Empty output file.** The dataset is in a third format the importer does
  not yet recognize. Run with `--debug` to print the first row and file a
  GitHub issue with the redacted shape.
- **High skip count.** Often a stray `\r\n` line ending or a trailing comma
  on the final row. Run `dos2unix ./fine_tuning_data.jsonl` and retry.
- **"namespace already has captures"** The target namespace already holds
  imports from a prior run. Either pass `--append` or pick a fresh
  `--namespace` to start clean.

### Step 2 of 6: Spec

```bash
kolm distill spec \
  --namespace support \
  --base qwen2.5-7b-instruct \
  --teachers claude-opus-4-7,gpt-4o,cerebras:llama-3.3-70b \
  --output ./distill-spec.json
```

Annotated output:

```
[spec] base model: qwen2.5-7b-instruct (resolved to hf://Qwen/Qwen2.5-7B-Instruct)
[spec] teachers: 3
[spec]   - claude-opus-4-7        weight 0.40 (default)
[spec]   - gpt-4o                 weight 0.40 (default)
[spec]   - cerebras:llama-3.3-70b weight 0.20 (default)
[spec] LoRA: r=16 alpha=32 dropout=0.05
[spec] training: bf16 + grad-ckpt + batch=1 + ml=384
[spec] eval block: agreement-rate against namespace holdout (auto-split 90/10)
[spec] wrote ./distill-spec.json
[spec] OK
```

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | Spec written. |
| 2 | Bad arguments. Unknown teacher slug, unknown base model, etc. |
| 5 | Teacher slug not in the whitelist. Run `kolm teachers list` for the supported set. |

The default teacher weights (0.40 / 0.40 / 0.20) reflect the empirical balance
that worked for Trinity-500. Override with `--teacher-weights 0.5,0.3,0.2` if
you have a reason to bias toward a specific lineage.

### Step 3 of 6: Collect

```bash
kolm distill collect \
  --spec ./distill-spec.json \
  --captures ./captures.jsonl \
  --out ./training-pairs.jsonl
```

Annotated output:

```
[collect] reading ./distill-spec.json
[collect] reading ./captures.jsonl (998 rows)
[collect] running 3 teachers in parallel per row (max concurrency 8)
[collect] progress: 100/998 (10%) ETA 4m 12s
[collect] progress: 500/998 (50%) ETA 2m 18s
[collect] progress: 998/998 (100%) done in 4m 41s
[collect] wrote 998 training pairs to ./training-pairs.jsonl
[collect] teacher latency p50/p99: claude 1.8s/4.2s, gpt-4o 2.1s/5.6s, cerebras 0.4s/0.8s
[collect] estimated council cost: $3.27
[collect] OK
```

Each row in `training-pairs.jsonl` carries the original prompt, the three
teacher responses, the council-merged response, and the per-teacher
provenance fields (request id, timestamp, model id, latency).

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | All rows collected. |
| 6 | More than 10% of rows failed for at least one teacher. Re-run with `--resume` to fill gaps. |
| 7 | Rate-limited by a teacher provider. The CLI backs off automatically; if it gives up, this exit code surfaces. Lower `--concurrency` and retry. |

### Step 4 of 6: Train

```bash
kolm distill train \
  --spec ./distill-spec.json \
  --pairs ./training-pairs.jsonl \
  --out ./support-v1.kolm
```

Annotated output:

```
[train] base: Qwen2.5-7B-Instruct loaded in bf16 (14.2 GB VRAM)
[train] LoRA adapter initialized (r=16, 23.6 MB trainable)
[train] training: 998 pairs, 1 epoch, batch=1, grad-ckpt on
[train] step 100/998 loss 1.42 lr 1e-4
[train] step 500/998 loss 0.81 lr 1e-4
[train] step 998/998 loss 0.63 lr 1e-4
[train] done in 84.2s on RTX 5090
[train] merging adapter into full weights
[train] signing with Ed25519 (key: tenant_82a96045630.signing)
[train] writing passport: spec + K-Score block + runtime passport
[train] artifact: ./support-v1.kolm (4.3 GB)
[train] OK
```

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | Artifact written and signed. |
| 8 | CUDA out-of-memory. Pass `--micro-batch 1 --grad-accum 4` or use a larger card. |
| 9 | No signing key configured. Run `kolm key init` or `kolm login` to provision one. |

### Step 5 of 6: Evaluate

```bash
kolm eval \
  --artifact ./support-v1.kolm \
  --baseline-jsonl ./fine_tuning_data.jsonl \
  --metric agreement-rate \
  --out ./eval-report.json
```

Annotated output:

```
[eval] loading artifact ./support-v1.kolm
[eval] sampling 50 rows from baseline (use --full for all rows)
[eval] running artifact against 50 prompts
[eval] running judge (claude-opus-4-7) on 50 paired responses
[eval] agreement-rate: 47/50 = 94.0%
[eval] mean response length: 198 chars (baseline: 215 chars)
[eval] mean latency: 0.9s (baseline: 1.4s)
[eval] wrote ./eval-report.json
[eval] PASS (>= 90% threshold)
```

A passing agreement-rate (default threshold: 90%) means the distilled student
is producing semantically equivalent responses to the OpenAI baseline on the
held-out fixture. The threshold is configurable with `--threshold 0.85` if
you want to ship a smaller model that trades some agreement for lower cost.

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | Eval ran and passed the threshold. |
| 1 | Eval ran but agreement-rate fell below threshold. The report is still written; inspect it for which rows diverged. |
| 10 | Baseline JSONL has no usable holdout (every row was already in training). Pass `--holdout-jsonl` explicitly. |

### Step 6 of 6: Deploy

```bash
kolm deploy ./support-v1.kolm \
  --target vllm \
  --target gguf-q4km \
  --target ollama
```

Annotated output:

```
[deploy] reading ./support-v1.kolm
[deploy] target: vllm
[deploy]   wrote ./deploy/vllm/Dockerfile
[deploy]   wrote ./deploy/vllm/start.sh
[deploy]   wrote ./deploy/vllm/k8s-deployment.yaml
[deploy] target: gguf-q4km
[deploy]   quantizing fp16 -> Q4_K_M (4.3 GB -> 4.1 GB)
[deploy]   wrote ./deploy/gguf/support-v1.q4km.gguf
[deploy] target: ollama
[deploy]   wrote ./deploy/ollama/Modelfile
[deploy]   wrote ./deploy/ollama/import.sh
[deploy] all targets ready
[deploy] OK
```

Each target produces a self-contained directory you can ship to wherever the
model needs to run. The vLLM bundle includes Kubernetes manifests; the GGUF
bundle is one file that runs in llama.cpp, LM Studio, or any compatible
runtime; the Ollama bundle has an import script.

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | All targets built successfully. |
| 11 | Unknown target. Run `kolm deploy --help` for the list. |
| 12 | Quantization failed (usually because the conversion toolchain is missing). The CLI prints the install command for the missing dependency. |

## Verification

After step 6, the smoke test:

```bash
# Start the vLLM server locally
docker run --gpus all -p 8000:8000 \
  -v $(pwd)/deploy/vllm:/app \
  vllm/vllm-openai:latest \
  --model /app/support-v1

# In another shell, send a request
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "support-v1",
    "messages": [{"role":"user","content":"What is your refund policy?"}]
  }'
```

Expected: an OpenAI-shaped response with a `choices[0].message.content` field
populated by the distilled student. The response should be substantively
similar to what the OpenAI fine-tuned model produced for the same prompt
(this is what the step 5 agreement-rate measured).

To verify the artifact's signature without serving it:

```bash
kolm verify ./support-v1.kolm
# prints signer key id, training spec hash, K-Score block, deploy passport
# exits 0 if signature valid, 13 if invalid
```

## Troubleshooting

### 1. `kolm import` skips most rows

The dataset is probably in a custom format the importer does not recognize.
Inspect the first row:

```bash
head -1 ./fine_tuning_data.jsonl | python -m json.tool
```

Supported shapes are documented in `src/importers/openai-finetune.js`. If
yours is close but not identical, the importer config accepts a custom field
mapping via `--map-system messages.0.content --map-user messages.1.content`.

### 2. `kolm distill collect` runs forever / costs too much

The collector defaults to running every imported row through every teacher.
For a dataset of 10k+ rows this gets expensive. Cap with `--max-rows 1000`
and `--sample random` to draw a stratified sample. Trinity-500 was trained
on 410 pairs; you rarely need more than 1-2k for a 7B distill to converge.

### 3. CUDA out-of-memory during training

The 7B base in bf16 needs 14.2 GB just for the weights. Reduce the footprint
with:

```bash
kolm distill train \
  --spec ./distill-spec.json \
  --pairs ./training-pairs.jsonl \
  --out ./support-v1.kolm \
  --micro-batch 1 \
  --grad-accum 4 \
  --max-seq-len 256
```

Or move the training step to a larger card. RunPod's RTX 4090 community
cloud at $0.39/hr is sufficient for one full distill run in under 5 minutes.

### 4. Eval agreement-rate is below the threshold

Three common causes:

- **Holdout leaked into training.** Re-split with `--holdout-jsonl
  ./separate-holdout.jsonl` and re-run.
- **Base model too small.** A 7B is not large enough for some open-ended
  generation tasks. Re-spec with `--base qwen2.5-32b-instruct` and retrain.
- **Council too narrow.** If only one teacher is configured, the student
  inherits its blind spots. Add a second lineage (DeepSeek-R1 if you only
  had Claude + GPT-4o, or vice-versa).

### 5. Deploy step says "quantization toolchain missing"

GGUF Q4_K_M requires `llama.cpp`'s `quantize` binary on PATH. Install with:

```bash
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp && make
sudo cp build/bin/quantize /usr/local/bin/llama-quantize
```

Or skip the GGUF target and ship only vLLM + Ollama, which have no
external-binary dependencies.

## Next steps

After a successful migration:

- **Wire the kolm gateway in front of your app.** Point `OPENAI_BASE_URL` at
  `https://kolm.ai/v1` (or your self-hosted gateway) so new traffic accumulates
  fresh capture rows. The next distill is trained on real production data,
  not just the OpenAI ft seed dataset.
- **Schedule periodic redistills.** A weekly cron of `kolm distill collect
  --since 7d` and `kolm distill train` keeps the local artifact in step with
  drifting production data.
- **Deploy to additional targets.** The TGI, TRT-LLM, and edge-binary targets
  are available; see `kolm deploy --help` for the full list.
- **Export the audit trail.** Every step above wrote one signed receipt.
  `kolm export --audit --since 2026-05-28` packages them into a SOC 2 /
  HIPAA / EU AI Act evidence bundle.

The full feature matrix against OpenAI ft, Vertex Tuning, Bedrock Custom
Models, and Azure OpenAI is documented at `/openai-migration` and
`/compare`.
