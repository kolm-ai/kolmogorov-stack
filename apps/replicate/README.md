# kolm-trainer on Replicate (Cog)

Self-contained Cog model for the `replicate` compute backend in
`apps/trainer/backends/replicate_runner.py`.

After you push this once into your Replicate account, the kolm CLI
(`kolm compute use replicate`) will dispatch LoRA training jobs to it.

## Prerequisites

- A Replicate account: https://replicate.com
- The Cog CLI installed: https://github.com/replicate/cog#install
- A Docker daemon running locally (Cog builds the container image
  before pushing).

## Build

From this directory:

```
cog build
```

Cog reads `cog.yaml` and builds a CUDA 12.1 image with Python 3.11,
torch 2.4, transformers 4.45, peft 0.13, accelerate, bitsandbytes,
datasets, httpx, and sentencepiece.

The first build takes a while because Cog has to pull the CUDA base
layer and install bitsandbytes. Subsequent builds reuse the layer
cache.

## Push

Log in and push to Replicate:

```
cog login
cog push r8.im/<your-username>/kolm-trainer
```

Replicate prints the new model version SHA at the end of the push.
Note the `<your-username>/kolm-trainer:<sha>` string.

## Wire up kolm

Tell the kolm runner where the model lives:

```
export KOLM_REPLICATE_TOKEN=<your-replicate-api-token>
export KOLM_REPLICATE_MODEL=<your-username>/kolm-trainer:<version-sha>
```

You can get an API token at https://replicate.com/account/api-tokens.

## Smoke test

The fastest way to confirm the deploy works is the Replicate web UI:
open the model page and run a prediction with the default spec. The
output should be a JSON dict with `metrics`, `adapter_bytes`,
`adapter_filename`, `device`, and `cost_usd` fields.

From the kolm side:

```
kolm compute test replicate
```

That submits a 32-pair tiny corpus through the runner adapter, verifies
the result envelope, downloads the adapter, and re-hashes it to confirm
byte equivalence with the receipt.

## Configuration

All settings are environment variables read at container start. Set
them at build time or via Replicate's hardware/secrets dashboard:

| Variable                              | Default                       | Notes                                  |
|---------------------------------------|-------------------------------|----------------------------------------|
| `KOLM_REPLICATE_GPU`                  | `A40`                         | Reported in `device` field.            |
| `KOLM_REPLICATE_HOURLY_RATE_USD`      | `5.49`                        | A40 rate. Bump for A100.               |
| `KOLM_REPLICATE_MAX_PAIRS`            | `50000`                       | Hard cap on input pair count.          |
| `KOLM_REPLICATE_DEFAULT_BASE`         | `Qwen/Qwen2.5-0.5B-Instruct`  | Pre-warmed by `setup()`.               |
| `KOLM_REPLICATE_EPOCHS`               | `3`                           | Training epochs.                       |
| `KOLM_REPLICATE_EVAL_MAX_NEW`         | `32`                          | Holdout generation budget.             |

## Upgrading to A100

The default Replicate hardware tier for this Cog model is A40 (24GB).
To run on A100-40GB:

1. Open your model on replicate.com.
2. Go to Settings, scroll to Hardware, pick `A100 (40GB)` or
   `A100 (80GB)`.
3. Trigger a new build or just save the setting.
4. Update the rate: `export KOLM_REPLICATE_HOURLY_RATE_USD=4.14` for
   A100-40GB ($0.001150/sec) or `5.04` for A100-80GB ($0.001400/sec).

Cost figures are based on Replicate's published per-second pricing at
the time this template ships. Confirm current rates at
https://replicate.com/pricing before you bill end users.

## Cost model

The predictor reports
`cost_usd = (duration_seconds / 3600) * HOURLY_RATE_USD`.
A40 default is `$5.49/hr` (Replicate posts `$0.001525/sec`).

## Pre-warm cache

`setup()` pulls `KOLM_REPLICATE_DEFAULT_BASE` into the HF cache when
the container boots so the first real prediction skips the multi-GB
download. If you have a tenant with a different hot base, change
`KOLM_REPLICATE_DEFAULT_BASE` and rebuild.

## Receipts

The predictor returns the same canonical-JSON receipt fields as the
local trainer (`adapter_sha256`, `k_score`, `accuracy`,
`receipt_canonical_sha256`). The kolm runtime re-verifies these against
`packages/runtime-rs` after download, so a Replicate-trained `.kolm`
is indistinguishable from a locally-trained one once it lands on disk.
