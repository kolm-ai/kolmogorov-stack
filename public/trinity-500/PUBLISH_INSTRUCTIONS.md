# Trinity-500 — HuggingFace Publish Instructions

Manual upload steps. The kolm publish orchestrator (`scripts/publish-trinity.cjs`) is dry-run only by design — it never pushes to HuggingFace. A maintainer copy-pastes the commands below when ready.

## Token requirement

A HuggingFace **write** token scoped to the target organization (`kolm-ai`) is required.

```bash
# 1. Create a write token at https://huggingface.co/settings/tokens
#    Scope: "Write to kolm-ai"
export HF_TOKEN="hf_..."
```

The token is **never** committed, **never** added to .env, **never** logged. It lives only in the maintainer's shell for the upload session.

## Target repository

`kolm-ai/trinity-500-support-7b` (see `publication-manifest.json:target_repo`)

## One-time setup

```bash
# Install the HuggingFace CLI (one-time)
pip install --upgrade huggingface_hub

# Log in (uses HF_TOKEN env var if present)
huggingface-cli login --token "$HF_TOKEN"

# Create the model repo (one-time)
huggingface-cli repo create kolm-ai/trinity-500-support-7b --type model
```

## Upload artifacts

Source paths from `publication-manifest.json` (Windows host where the distill ran):

```bash
ARTIFACT_DIR="$HOME/.kolm/distill-runs/trinity-500-2026-05-26"

# 1. Model card (README + frontmatter)
huggingface-cli upload \
  kolm-ai/trinity-500-support-7b \
  public/trinity-500/README.md \
  README.md

# 2. LoRA adapter (qwen-merged/)
huggingface-cli upload \
  kolm-ai/trinity-500-support-7b \
  "$ARTIFACT_DIR/merged/qwen-merged" \
  qwen-merged \
  --repo-type model

# 3. GGUF quantization ladder (5 files, largest is f16 at ~15 GB)
for q in f16 q8_0 q5_k_m q4_k_m iq4_xs; do
  huggingface-cli upload \
    kolm-ai/trinity-500-support-7b \
    "$ARTIFACT_DIR/merged/gguf/trinity-500-$q.gguf" \
    "gguf/trinity-500-$q.gguf"
done

# 4. Importance matrix (used to compute the IQ4_XS quant)
huggingface-cli upload \
  kolm-ai/trinity-500-support-7b \
  "$ARTIFACT_DIR/merged/gguf/trinity-500.imatrix" \
  "gguf/trinity-500.imatrix"

# 5. Ollama Modelfile
huggingface-cli upload \
  kolm-ai/trinity-500-support-7b \
  "$ARTIFACT_DIR/merged/gguf/Modelfile" \
  "Modelfile"

# 6. Passport (signed provenance)
huggingface-cli upload \
  kolm-ai/trinity-500-support-7b \
  "$ARTIFACT_DIR/merged/passport.json" \
  "passport.json"

# 7. Benchmark artifacts
huggingface-cli upload \
  kolm-ai/trinity-500-support-7b \
  "$ARTIFACT_DIR/merged/benchmark-summary.json" \
  "benchmarks/benchmark-summary.json"

huggingface-cli upload \
  kolm-ai/trinity-500-support-7b \
  "$ARTIFACT_DIR/merged/benchmark-raw.jsonl" \
  "benchmarks/benchmark-raw.jsonl"

huggingface-cli upload \
  kolm-ai/trinity-500-support-7b \
  "$ARTIFACT_DIR/merged/benchmark-table.md" \
  "benchmarks/benchmark-table.md"
```

## Post-upload verification

```bash
# Smoke-test the published artifact
huggingface-cli download kolm-ai/trinity-500-support-7b --include "gguf/trinity-500-q4_k_m.gguf" --local-dir /tmp/trinity-verify

# Load + run with llama.cpp
llama-cli -m /tmp/trinity-verify/gguf/trinity-500-q4_k_m.gguf \
  -p "I want to return an item I bought last week." \
  --temp 0 -n 256

# Expected: model asks one clarifying question (order ID), does not invent
# inventory state, stays on the published return policy.
```

## Auto-update the publication manifest

Rerun the orchestrator with `--full-hash` after upload to compute sha256s for the manifest:

```bash
node scripts/publish-trinity.cjs --full-hash --emit-manifest public/trinity-500/publication-manifest.json
```

Commit + push the updated manifest so consumers can verify their downloads against the published sha256.

## Rollback

```bash
# Soft-delete the repo (HuggingFace retains for 30 days)
huggingface-cli repo delete kolm-ai/trinity-500-support-7b --type model --yes
```

---

**Status as of 2026-05-27:** all artifacts exist on the distill host; manifest written; README mirrored; the upload step is **gated on maintainer authorization + HF_TOKEN**. No automation will push without a person typing the commands above.
