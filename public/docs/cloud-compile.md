---
title: kolm compile · cloud (Modal)
status: V1 scaffold - CLI wiring is a follow-up
---

# kolm compile · cloud (Modal)

Cloud compile lets you run `kolm compile` against a Modal-hosted GPU when your
own machine cannot host the model. The Kolm side is a thin driver; Modal owns
the GPU pool and the billing.

## When you need it

Reach for cloud compile when any of these is true:

- You do not have a local NVIDIA GPU (no 4090 / 5090 / A6000).
- The source model is larger than ~24 GB in bf16 (DeepSeek-R1-32B, Llama-3.1-70B,
  Qwen-2.5-72B) and will not fit on consumer cards even at NF4.
- You want a one-shot quantize for an artifact you will keep and serve forever,
  and you would rather rent an H100 for three minutes than buy hardware.

If your model is ≤ 7 B and you have any modern GPU, run locally instead - it
will be faster and free.

## Setup

You need Python 3.10+ and the Modal CLI.

```bash
pip install modal
modal token new
```

`modal token new` opens a browser, authenticates against modal.com, and writes
`~/.modal.toml`. The Kolm driver looks for either that file OR the
`MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` environment variables.

If the source model is HuggingFace-gated (Llama, etc.), also create a Modal
Secret named `huggingface` containing your `HF_TOKEN`:

```bash
modal secret create huggingface HF_TOKEN=hf_...
```

## Run

The CLI surface (follow-up wave):

```bash
kolm compile --cloud modal --model deepseek-ai/DeepSeek-R1-Distill-Qwen-32B \
             --quant nf4-int4 --out ./out/r1-32b-int4
```

Until the CLI wires through, you can invoke the driver directly:

```bash
node scripts/compile-cloud.cjs --model deepseek-ai/DeepSeek-R1-Distill-Qwen-32B \
                               --quant nf4-int4 --out ./out/r1-32b-int4
```

By default the driver runs in `--dry-run` mode: it prints the exact `modal run`
command it would invoke and exits 0. Pass `--run` to fire it.

To pull the resulting artifact back to your machine:

```bash
modal volume get kolm-compile-out \
  "deepseek-ai__DeepSeek-R1-Distill-Qwen-32B/nf4-int4" ./out/r1-32b-int4
```

## Cost

Modal bills the caller directly per GPU-second. Indicative on-demand pricing
(2026-05; check modal.com for current rates):

| GPU       | Hourly | 32 B NF4 quantize (typical) |
| --------- | ------ | --------------------------- |
| A100 40GB | ~$2-3  | ~5-8 min                    |
| A100 80GB | ~$3-4  | ~4-6 min                    |
| H100      | ~$5-8  | ~3 min                      |
| L4        | ~$1    | not enough VRAM for 32 B    |

A typical 32 B quantize finishes in well under one GPU-hour, so the all-in
cloud-compile cost is usually in the single-dollar range, plus a few cents
of network egress when you pull the artifact back.

Local equivalent for reference: the same DeepSeek-R1 32 B → 17.9 GB NF4
finished in 125 s on an RTX 5090 (see the SOTA quantize matrix in MEMORY).

## Caveats / Limitations

- **CLI wiring is not yet shipped.** `kolm compile --cloud modal` is the target
  surface; this wave (S-8) ships the driver and Modal app only. Use
  `node scripts/compile-cloud.cjs` directly for now.
- **No artifact stitch-back.** The Modal function writes to a `modal.Volume`;
  pulling it locally is a manual `modal volume get` until the wrapper lands.
- **GGUF profiles are deferred** on the Modal path. V1 covers
  `nf4-int4`, `int4`, and `int8` via bitsandbytes. GGUF (q4_k_m, q5_k_m, q8_0)
  needs llama.cpp `convert.py` + `quantize` and is a follow-up wave.
- **No retry / resume.** A Modal cold-start timeout means you re-invoke the
  driver. Modal does not refund cold-start time.
- **No metering inside Kolm.** Kolm does not bill or proxy. Modal bills your
  Modal account directly. Treat the cost table above as indicative, not
  contractual.
- **Gated-model auth is per-secret.** The driver does not auto-forward your
  local `HF_TOKEN` - set the `huggingface` Modal Secret as shown above.

## Related

- Local compile path: `kolm compile --quant nf4-int4` (no `--cloud` flag).
- Colab path: see `public/docs/colab-compile.html` for the notebook flow.
- Other cloud brokers (RunPod, SSH-S3): see `scripts/cloud-compute-broker.mjs`.
