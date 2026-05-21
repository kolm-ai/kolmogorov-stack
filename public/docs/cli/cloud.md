---
title: kolm cloud · kolm.ai
description: Real GPU fine-tunes and bring-your-own-cloud deploys.
---

# kolm cloud

> Real GPU fine-tunes and bring-your-own-cloud deploys. The kolm cloud signs the deploy script; weights and receipts live in your account.

## Usage

```bash
kolm cloud train <name> [--seeds <f.jsonl>] [--base <model>] [--confirm]
kolm cloud readiness [--remote] [--json]
kolm cloud storage [--provider <id>] [--smoke] [--json]
kolm cloud targets
kolm cloud deploy-plan --target <t> --artifact <id> [--json]
kolm cloud deploy --target <t> --artifact <id> [--region r] [--name n] [--team <id>] [--out <path>]
kolm cloud list
kolm cloud show <deployment_id>
kolm cloud destroy <deployment_id>
```

## Flags (train)

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--seeds <path>` | none | jsonl seed pairs |
| `--base <model>` | `Qwen/Qwen2.5-3B-Instruct` | base model id |
| `--target-size <s>` | `7b` | student model size |
| `--epochs <n>` | `3` | training epochs |
| `--lora-r <n>` | `16` | LoRA rank |
| `--lora-alpha <n>` | `32` | LoRA alpha |
| `--backend <b>` | `together` | training backend |
| `--budget <usd>` | none | refuse to start if the quote exceeds this |
| `--confirm` | off | actually run; without it you just get a quote |

## Artifact storage

`kolm cloud storage --json` reports the artifact object-store plane without printing secret values. It covers local disk, R2 REST, R2 S3-compatible, AWS S3, generic S3, and Supabase S3.

Use `--smoke` only on a machine that owns the credentials. The smoke path writes a tiny object, reads it back, verifies the bytes, and deletes it.

```bash
kolm cloud storage --json
kolm cloud storage --provider local-artifacts --smoke --json
kolm cloud storage --provider cloudflare-r2-s3 --smoke --json
```

## Train backends

| Backend | Notes |
| ------- | ----- |
| `together` (default) | managed LoRA fine-tune on Together AI. Requires `KOLM_TOGETHER_TOKEN`. Cost ~$2-5 for Qwen 2.5 7B on 2k pairs, ~30-45 min |
| `runpod, lambda, vast` | available through compute profiles listed by `kolm compute list` when credentials are configured |

## Deploy targets

`fly`, `aws-nitro`, `gcp-cvm`, `azure-cvm`, `docker`.

## Examples

```bash
# quote first
kolm cloud train phi-redactor --seeds seeds.jsonl
# spend money
kolm cloud train phi-redactor --seeds seeds.jsonl --confirm

# byoc deploy
kolm cloud targets
kolm cloud storage --json
kolm cloud storage --provider cloudflare-r2-s3 --smoke --json
kolm cloud deploy-plan --target cloudflare-workers --artifact phi-redactor --json
kolm cloud deploy --target fly --artifact phi-redactor --region iad
kolm cloud list
kolm cloud show dep_018b1f
kolm cloud destroy dep_018b1f
```

## See also

- [Quickstart](/quickstart)
- [kolm distill](/docs/cli/distill)
- [kolm compile](/docs/cli/compile)
- [BYOC](/byoc)
- [API reference](/docs/api)
