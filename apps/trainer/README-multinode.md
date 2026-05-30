# Multi-node / FSDP launcher (`multinode_launch.py`)

Orchestrates a distributed QLoRA or full fine-tune of a **>32B** model across
N GPUs and/or N nodes. It is **additive**: it does not modify any existing
trainer. It resolves a launch plan (world size, FSDP sharding, per-GPU memory
budget, offload, activation checkpointing), generates the launcher config, and
then shells out to one of the existing trainers (`distill.py`, `ropd.py`,
`grpo.py`, `qad.py`, ...) under `torchrun` or `accelerate launch`.

The heavy frameworks (torch / accelerate) are **never imported at module load**,
so `--dry-run` resolves and prints the full plan + per-GPU memory estimate on a
laptop or CI box with **no GPUs and no deep-learning deps installed**.

## Why this exists

The existing trainers run on a single device (or a single multi-GPU box via
their own loops). Models above ~32B in `bf16` do not fit on one GPU once you add
gradients, optimizer state, and activations. FSDP `FULL_SHARD` shards the frozen
base weights — the dominant memory term for >32B — across the whole world, which
is what makes a 70B/72B QLoRA fit on a single 8×H100 node, and a full fine-tune
fit across 2+ nodes.

## Quick start

### Resolve + print the plan only (no GPUs needed — verifiable here)

```bash
python multinode_launch.py \
  --model deepseek-ai/DeepSeek-R1-Distill-Llama-70B \
  --nodes 2 --gpus-per-node 8 --gpu a100-80gb \
  --mode qlora --dry-run
```

### Single 8×H100 node, QLoRA, distill trainer

```bash
python multinode_launch.py \
  --model Qwen/Qwen2.5-72B-Instruct \
  --gpus-per-node 8 --gpu h100-80gb --mode qlora \
  --trainer distill -- --data data/pairs.jsonl --out out/qwen72b
```

Everything after `--` is passed through verbatim to the trainer script.

### Multi-node (run the *same* command on every node)

Most schedulers (RunPod, Lambda, Slurm, torchrun's own elastic agent) export
`MASTER_ADDR`, `NODE_RANK`, `NNODES`, `WORLD_SIZE`. The launcher reads them, so
you usually run an identical command on each node:

```bash
# scheduler exports MASTER_ADDR / NODE_RANK / NNODES; or pass them explicitly:
MASTER_ADDR=10.0.0.1 NODE_RANK=0 NNODES=2 NPROC_PER_NODE=8 \
  python multinode_launch.py \
    --model meta-llama/Llama-3.1-70B \
    --gpu a100-80gb --mode full --launch \
    --trainer distill -- --data data/sft.jsonl --out out/llama70b-full
```

## Self-check (no GPUs)

```bash
# 1. compiles
python -c "import py_compile; py_compile.compile('multinode_launch.py', doraise=True); print('COMPILE_OK')"

# 2. dry-run prints a plan and exits 0 without launching
python multinode_launch.py \
  --model meta-llama/Llama-3.1-70B \
  --nodes 2 --gpus-per-node 8 --gpu a100-80gb --mode qlora --dry-run
```

## How the plan is resolved

### Topology (CLI overrides env overrides defaults)

| Concept        | CLI flag            | Env var                          | Default               |
| -------------- | ------------------- | -------------------------------- | --------------------- |
| nodes          | `--nodes`           | `NNODES`                         | 1                     |
| GPUs per node  | `--gpus-per-node`   | `NPROC_PER_NODE`/`GPUS_PER_NODE` | 1                     |
| world size     | `--world-size`      | `WORLD_SIZE`                     | nodes × gpus_per_node |
| this node rank | `--node-rank`       | `NODE_RANK` (or `RANK`/gpn)      | 0                     |
| master host    | `--master-addr`     | `MASTER_ADDR`                    | 127.0.0.1             |
| master port    | `--master-port`     | `MASTER_PORT`                    | 29500                 |

### Sharding strategy (`--sharding auto` by default)

| Mode    | Single node      | Multi-node       |
| ------- | ---------------- | ---------------- |
| qlora   | `FULL_SHARD`     | `FULL_SHARD`     |
| lora    | `FULL_SHARD`     | `FULL_SHARD`     |
| full    | `FULL_SHARD`     | `HYBRID_SHARD`   |

`HYBRID_SHARD` shards within a node and replicates across nodes, which cuts
cross-node all-gather traffic on slower fabrics. Override with `--sharding`.

### Per-GPU memory estimate

The estimate models four FSDP buckets and is intentionally conservative:

* **base weights** — frozen params: QLoRA `0.5 B/param` (4-bit NF4), LoRA/full
  `2 B/param` (bf16). Sharded `1/world` under `FULL_SHARD`.
* **trainable params** — LoRA adapters (`--lora-param-fraction`, ~0.3% default)
  or all params for `--mode full`.
* **gradients + optimizer state** — Adam `m`+`v` (fp32) plus an fp32 master copy
  for full fine-tunes; sharded under `FULL_SHARD`.
* **activations** — `micro_batch × seq_len × hidden × layers`, reduced by
  `1/sqrt(layers)` when activation checkpointing is on (default on).
* **overhead** — CUDA context + NCCL buffers.

If the plan does not fit, the launcher **auto-enables `--cpu-offload`** (disable
with `--no-auto-offload`). The dry-run output ends with `FITS` / `DOES NOT FIT`
and actionable notes (add GPUs/nodes, switch to qlora, lower seq-len, etc.).

Parameter count and architecture are inferred from the model id (e.g. `...-70B`,
`8x7b` MoE) but should be pinned with `--params-billion`, `--hidden-size`, and
`--num-layers` for an exact estimate.

## Launchers

* `--launcher torchrun` (default) — emits a `torchrun` command. Single node uses
  `--master_addr/--master_port`; multi-node uses the `c10d` rendezvous
  (`--rdzv_backend/--rdzv_id/--rdzv_endpoint`).
* `--launcher accelerate` — writes a generated `accelerate` FSDP YAML config and
  emits an `accelerate launch` command. The config maps our strategy names onto
  accelerate's `fsdp_sharding_strategy` enum and enables
  `SHARDED_STATE_DICT`, `cpu_ram_efficient_loading`, `limit_all_gathers`,
  `use_orig_params`, and transformer-based auto-wrap.

## Environment exported to the trainer subprocess

The launcher exports a consistent FSDP contract so the trainer does not re-parse
CLI:

```
KOLM_FSDP=1
KOLM_FSDP_SHARDING=FULL_SHARD|SHARD_GRAD_OP|HYBRID_SHARD|NO_SHARD
KOLM_FSDP_CPU_OFFLOAD=0|1
KOLM_FSDP_MIXED_PRECISION=bf16|fp16|fp32
KOLM_FSDP_ACT_CKPT=0|1
KOLM_TRAIN_MODE=qlora|lora|full
MASTER_ADDR / MASTER_PORT
OMP_NUM_THREADS
NCCL_ASYNC_ERROR_HANDLING=1 / TORCH_NCCL_ASYNC_ERROR_HANDLING=1
NCCL_SOCKET_IFNAME=<--nccl-socket-ifname>   # multi-node fabrics
KOLM_FSDP_NVME_DIR=<--nvme-offload-dir>     # very large full finetunes
```

A trainer that wants to participate in FSDP can read `KOLM_FSDP*` and wrap its
model accordingly; trainers that ignore these vars still run unchanged under the
distributed launcher (torchrun sets `RANK`/`LOCAL_RANK`/`WORLD_SIZE` for them).

## GPU catalog

Known SKUs (usable HBM, GiB) are kept in sync with the cloud backends under
`src/compute/backends/` (`runpod.js`, `lambda.js`, `modal.js`, `vast.js`,
`together.js`): A100-40/80, H100-80/94 (NVL), H200-141, B200-180, L40S-48,
L4-24, A6000-48, A40-48, RTX 4090/5090/3090, MI300X-192, MI250X-128. Short
aliases are accepted (`h100`, `a100`, `mi300x`, `5090`, ...). For an unlisted
card pass `--gpu-mem-gib`.

## JSON output

`--json` emits the fully resolved plan (topology, sharding, memory buckets,
launch command, env overrides, generated accelerate config) for programmatic
consumption (e.g. the compute scheduler in `src/compute/`).

## Notes / limitations

* The memory estimate is a planning aid, not a guarantee — real usage depends on
  the exact model arch, attention impl (FlashAttention reduces activations),
  tokenizer padding, and FSDP wrapping granularity. Treat the headroom as a
  margin, not a hard line.
* MoE total-vs-active parameter routing is not modeled; pin `--params-billion`.
* The launcher does not provision hardware. Pair it with the compute backends
  (`src/compute/backends/runpod.js`, `lambda.js`, `modal.js`) to acquire the
  multi-GPU/multi-node allocation, then run this on the allocated nodes.
