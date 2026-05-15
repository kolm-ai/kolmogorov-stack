# kolm-trainer on Modal

Self-contained Modal app template for the `modal` compute backend in
`apps/trainer/backends/modal_runner.py`.

After you deploy this once into your own Modal account, the kolm CLI
(`kolm compute use modal`) will dispatch LoRA training jobs to it.

## Prerequisites

- A Modal account: https://modal.com
- The Modal CLI installed and authenticated:
  ```
  pip install modal
  modal token new
  ```
- An A100-40GB or larger GPU available in your Modal workspace. Modal
  defaults work out of the box for new accounts.

## Deploy

From this directory:

```
modal deploy kolm_trainer_app.py
```

That command publishes a Modal App named `kolm-trainer` with one
Function: `train_lora`. The Modal CLI prints the deploy URL when it
finishes.

## Wire up kolm

Tell the kolm runner where the function lives by exporting two env vars
in the shell where you run `kolm`:

```
export KOLM_MODAL_APP_NAME=kolm-trainer
export KOLM_MODAL_FUNCTION_NAME=train_lora
export KOLM_MODAL_TOKEN_ID=<your-modal-token-id>
export KOLM_MODAL_TOKEN_SECRET=<your-modal-token-secret>
```

If you renamed the App or Function above, set those env vars to match.

## Smoke test

The fastest way to confirm the deploy works is the built-in
`local_entrypoint`. It submits a tiny job and prints the result:

```
modal run kolm_trainer_app.py::smoke \
  --corpus-url https://raw.githubusercontent.com/kolmai/sample-corpora/main/refund_classifier.jsonl \
  --base-model sshleifer/tiny-gpt2
```

You should see JSON with `device`, `cost_usd`, `accuracy`, `k_score`,
and `adapter_size_bytes` fields. Anything non-zero means the deploy is
live.

From the kolm side:

```
kolm compute test modal
```

That submits a 32-pair tiny corpus through the runner adapter, verifies
the result envelope, downloads the adapter, and re-hashes it to confirm
byte equivalence with the receipt.

## Configuration

All settings are environment variables read at deploy time. Set them
before `modal deploy`:

| Variable                          | Default                       | Notes                                  |
|-----------------------------------|-------------------------------|----------------------------------------|
| `KOLM_MODAL_APP_NAME`             | `kolm-trainer`                | App name used by `Function.lookup`.    |
| `KOLM_MODAL_FUNCTION_NAME`        | `train_lora`                  | Function name used by the runner.      |
| `KOLM_MODAL_GPU`                  | `A100-40GB`                   | `A100-80GB`, `H100`, `L40S`, etc.      |
| `KOLM_MODAL_TIMEOUT_SECONDS`      | `1800`                        | Per-call wall-clock budget.            |
| `KOLM_MODAL_REGION`               | `us-east`                     | Modal region hint.                     |
| `KOLM_MODAL_HOURLY_RATE_USD`      | `2.50`                        | Used for cost field on receipt.        |
| `KOLM_MODAL_MAX_PAIRS`            | `50000`                       | Hard cap on input pair count.          |
| `KOLM_MODAL_DEFAULT_BASE`         | `Qwen/Qwen2.5-0.5B-Instruct`  | Used when spec.base_model is empty.    |
| `KOLM_MODAL_EPOCHS`               | `3`                           | Training epochs.                       |
| `KOLM_MODAL_EVAL_MAX_NEW`         | `32`                          | Holdout generation budget.             |

## Cost model

The function reports `cost_usd = (duration_seconds / 3600) * HOURLY_RATE_USD`.
The default rate is `$2.50/hr` (Modal A100-40GB). If you negotiate a
different SKU, set `KOLM_MODAL_HOURLY_RATE_USD` to match so receipts
show the correct cost.

## Volume cache

The app mounts a `modal.Volume` named `kolm-hf-cache` at `/cache`. HF
model weights are cached there across function invocations so cold
starts after the first call avoid the multi-GB download.

If you want to clear it (e.g. after a HF security advisory):

```
modal volume rm kolm-hf-cache
```

The next deploy recreates it.

## Receipts

The function returns the same canonical-JSON receipt fields as the
local trainer (`adapter_sha256`, `k_score`, `accuracy`,
`receipt_canonical_sha256`). The kolm runtime re-verifies these against
`packages/runtime-rs` after download, so a Modal-trained `.kolm` is
indistinguishable from a locally-trained one once it lands on disk.
