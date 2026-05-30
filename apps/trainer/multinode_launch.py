#!/usr/bin/env python3
"""
multinode_launch.py — Multi-node / FSDP training orchestrator for large (>32B) models.

This is the Kolmogorov Stack launcher (P2) that shards a QLoRA or full
fine-tune of a >32B model across N GPUs and/or N nodes. It is intentionally
*additive*: it does not modify any existing trainer. Instead it resolves a
distributed launch plan (world size, sharding strategy, per-GPU memory budget,
gradient checkpointing, CPU/NVMe offload) and then invokes an existing trainer
entrypoint under ``torchrun`` (preferred) or ``accelerate launch`` with a
generated FSDP/accelerate config.

Design goals
------------
1.  **Verifiable with no GPUs.**  ``--dry-run`` resolves and prints the full
    plan plus a per-GPU memory estimate and *never* imports torch / accelerate
    or launches anything. The heavy imports are deferred to the real launch
    path, so this file always ``python -c compile``s and ``--dry-run`` always
    runs on a laptop / CI box.
2.  **Reuse the existing trainers.**  The launcher does not re-implement the
    training loop; it shells out to one of the existing entrypoints
    (``distill.py``, ``ropd.py``, ``grpo.py``, ``qad.py`` ...). Trainer-specific
    flags are passed straight through after ``--``.
3.  **Standard rendezvous contract.**  Reads ``WORLD_SIZE``, ``RANK``,
    ``LOCAL_RANK``, ``NPROC_PER_NODE`` / ``GPUS_PER_NODE``, ``NNODES``,
    ``NODE_RANK``, ``MASTER_ADDR`` and ``MASTER_PORT`` from the environment
    (the variables that RunPod / Lambda / Modal / Slurm / ``torchrun`` already
    set), with explicit CLI overrides for every one of them.

Usage
-----
Resolve + print the plan only (no GPUs needed)::

    python multinode_launch.py \
        --model deepseek-ai/DeepSeek-R1-Distill-Llama-70B \
        --nodes 2 --gpus-per-node 8 --gpu a100-80gb \
        --mode qlora --dry-run

Actually launch (single 8xH100 node)::

    python multinode_launch.py \
        --model Qwen/Qwen2.5-72B-Instruct \
        --gpus-per-node 8 --gpu h100-80gb --mode qlora \
        --trainer distill -- --data data/pairs.jsonl --out out/qwen72b

Multi-node (run identically on every node; the scheduler sets NODE_RANK /
MASTER_ADDR, or pass them explicitly)::

    MASTER_ADDR=10.0.0.1 NODE_RANK=0 NNODES=2 \
      python multinode_launch.py --model ... --gpus-per-node 8 --launch -- ...

Self-check::

    python -c "import py_compile; py_compile.compile('multinode_launch.py', doraise=True)"
    python multinode_launch.py --model meta-llama/Llama-3.1-70B --nodes 2 \
        --gpus-per-node 8 --gpu a100-80gb --mode qlora --dry-run
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import math
import os
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Hardware catalog. Values are *usable* HBM in GiB (slightly under the marketing
# number to leave room for the CUDA context + fragmentation). Kept in sync, by
# convention, with the GPU SKUs offered by src/compute/backends/{runpod,lambda,
# modal,vast,together}.js. Override an unknown card with --gpu-mem-gib.
# ---------------------------------------------------------------------------
GPU_HBM_GIB: Dict[str, float] = {
    # NVIDIA data-center
    "a100-40gb": 39.5,
    "a100-80gb": 79.0,
    "h100-80gb": 79.0,
    "h100-94gb": 93.0,   # NVL / H100 94GB
    "h200-141gb": 140.0,
    "b200-180gb": 179.0,
    "l40s-48gb": 47.0,
    "l4-24gb": 23.0,
    "a6000-48gb": 47.0,
    "a40-48gb": 47.0,
    # consumer (RunPod community / Vast)
    "rtx4090-24gb": 23.0,
    "rtx5090-32gb": 31.0,
    "rtx3090-24gb": 23.0,
    # AMD
    "mi300x-192gb": 190.0,
    "mi250x-128gb": 127.0,
}

# Aliases so the user can type a short or marketing name.
GPU_ALIASES: Dict[str, str] = {
    "a100": "a100-80gb",
    "a100-80": "a100-80gb",
    "a100-40": "a100-40gb",
    "h100": "h100-80gb",
    "h100-nvl": "h100-94gb",
    "h200": "h200-141gb",
    "b200": "b200-180gb",
    "l40s": "l40s-48gb",
    "l4": "l4-24gb",
    "a6000": "a6000-48gb",
    "a40": "a40-48gb",
    "4090": "rtx4090-24gb",
    "rtx4090": "rtx4090-24gb",
    "5090": "rtx5090-32gb",
    "rtx5090": "rtx5090-32gb",
    "3090": "rtx3090-24gb",
    "mi300x": "mi300x-192gb",
    "mi250x": "mi250x-128gb",
}

# Bytes per parameter for the *frozen base weights* depending on training mode.
# QLoRA keeps the base in 4-bit NF4; LoRA keeps it in bf16; full keeps it in
# bf16 and *also* trains it (so optimizer state applies to all params).
BASE_BYTES_PER_PARAM = {
    "qlora": 0.5,   # 4-bit NF4 (~4 bits + small double-quant overhead)
    "lora": 2.0,    # bf16 frozen
    "full": 2.0,    # bf16, trainable
}

# Known existing trainer entrypoints in this directory. The launcher is generic;
# this map only validates --trainer and resolves it to a script path.
KNOWN_TRAINERS = {
    "distill": "distill.py",
    "ropd": "ropd.py",
    "grpo": "grpo.py",
    "qad": "qad.py",
    "contrastive": "contrastive_distill.py",
    "preference": "preference.py",
    "online_dpo": "online_dpo.py",
    "reward": "reward.py",
    "main": "main.py",
}

ADAM_BYTES_PER_TRAINABLE = 8.0   # fp32 m + v (2 * 4 bytes); master copy handled separately
GRAD_BYTES_PER_TRAINABLE = 2.0   # bf16 grads


# ---------------------------------------------------------------------------
# Plan dataclasses
# ---------------------------------------------------------------------------
@dataclass
class MemoryEstimate:
    """Per-GPU steady-state memory estimate, in GiB, broken out by bucket."""
    base_weights_gib: float
    base_weights_sharded_gib: float
    trainable_params_million: float
    grads_gib: float
    optimizer_gib: float
    activations_gib: float
    overhead_gib: float
    total_per_gpu_gib: float
    fits: bool
    headroom_gib: float
    notes: List[str] = field(default_factory=list)


@dataclass
class LaunchPlan:
    model: str
    model_params_billion: float
    mode: str                      # qlora | lora | full
    trainer: str
    trainer_script: str
    # topology
    nnodes: int
    gpus_per_node: int
    world_size: int
    node_rank: int
    master_addr: str
    master_port: int
    rdzv_backend: str
    rdzv_id: str
    # sharding
    sharding_strategy: str         # FULL_SHARD | SHARD_GRAD_OP | HYBRID_SHARD | NO_SHARD
    cpu_offload: bool
    nvme_offload_dir: Optional[str]
    activation_checkpointing: bool
    mixed_precision: str           # bf16 | fp16 | fp32
    # gpu
    gpu: str
    gpu_mem_gib: float
    # estimate + commands
    memory: MemoryEstimate
    launcher: str                  # torchrun | accelerate
    accelerate_config_path: Optional[str]
    command: List[str]
    trainer_args: List[str]
    env_overrides: Dict[str, str]

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        return d


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _env_int(name: str, default: Optional[int]) -> Optional[int]:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    try:
        return int(v)
    except ValueError:
        return default


def _env_str(name: str, default: Optional[str]) -> Optional[str]:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    return v


def normalize_gpu(name: str) -> str:
    key = name.strip().lower()
    if key in GPU_HBM_GIB:
        return key
    if key in GPU_ALIASES:
        return GPU_ALIASES[key]
    return key  # unknown; caller must supply --gpu-mem-gib


def resolve_gpu_mem(gpu: str, override_gib: Optional[float]) -> Tuple[float, List[str]]:
    notes: List[str] = []
    if override_gib is not None and override_gib > 0:
        notes.append(f"using --gpu-mem-gib override {override_gib:.1f} GiB")
        return float(override_gib), notes
    g = normalize_gpu(gpu)
    if g in GPU_HBM_GIB:
        return GPU_HBM_GIB[g], notes
    notes.append(
        f"unknown GPU '{gpu}'; defaulting to 80 GiB. Pass --gpu-mem-gib to be exact."
    )
    return 80.0, notes


def infer_params_billion(model: str, explicit: Optional[float]) -> Tuple[float, List[str]]:
    """Best-effort parameter count in billions.

    Prefers --params-billion. Otherwise parses a number followed by 'b' from
    the model id (e.g. '...-70B', 'Qwen2.5-72B-Instruct', 'mixtral-8x7b' ->
    treats explicit override as authoritative for MoE).
    """
    notes: List[str] = []
    if explicit is not None and explicit > 0:
        return float(explicit), notes
    import re
    lowered = model.lower()
    # MoE pattern like 8x7b / 8x22b -> total params (best effort)
    moe = re.search(r"(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*b", lowered)
    if moe:
        experts = int(moe.group(1))
        per = float(moe.group(2))
        total = experts * per
        notes.append(
            f"parsed MoE '{moe.group(0)}' -> ~{total:.0f}B total params "
            f"(pass --params-billion to override; active-param routing not modeled)"
        )
        return total, notes
    m = re.search(r"(\d+(?:\.\d+)?)\s*b\b", lowered)
    if m:
        val = float(m.group(1))
        notes.append(f"inferred {val:.0f}B params from model id")
        return val, notes
    notes.append(
        "could not infer parameter count from model id; assuming 70B. "
        "Pass --params-billion for an accurate memory estimate."
    )
    return 70.0, notes


def estimate_memory(
    params_billion: float,
    mode: str,
    world_size: int,
    gpu_mem_gib: float,
    sharding_strategy: str,
    cpu_offload: bool,
    activation_checkpointing: bool,
    seq_len: int,
    micro_batch: int,
    hidden_size: Optional[int],
    num_layers: Optional[int],
    lora_rank: int,
    lora_param_fraction: float,
) -> MemoryEstimate:
    """Steady-state per-GPU memory estimate (GiB). Deliberately conservative.

    The estimate models the four FSDP memory buckets:
      * base (frozen) weights — sharded across the world under FULL_SHARD,
      * trainable params (LoRA adapters, or all params for 'full'),
      * gradients + optimizer state for the trainable params (sharded),
      * activations (function of seq_len * micro_batch * hidden * layers).
    """
    notes: List[str] = []
    params = params_billion * 1e9

    # --- base weights ---
    base_bytes = params * BASE_BYTES_PER_PARAM[mode]
    base_gib = base_bytes / (1024 ** 3)

    # Under FULL_SHARD / HYBRID_SHARD the *parameters* are sharded across ranks
    # (within a node for HYBRID). NO_SHARD / SHARD_GRAD_OP keep a full param
    # replica resident on each GPU.
    if sharding_strategy in ("FULL_SHARD", "HYBRID_SHARD"):
        shard_div = world_size if sharding_strategy == "FULL_SHARD" else max(
            1, world_size // max(1, _nodes_from_world(world_size))
        )
        base_sharded_gib = base_gib / max(1, shard_div)
        notes.append(
            f"base weights sharded 1/{shard_div} under {sharding_strategy}"
        )
    else:
        base_sharded_gib = base_gib
        notes.append(f"base weights fully replicated under {sharding_strategy}")

    if cpu_offload:
        notes.append("CPU offload enabled: base shard + optimizer live in host RAM")
        base_sharded_gib *= 0.15  # only the active layer(s) stream onto the GPU

    # --- trainable params ---
    if mode == "full":
        trainable = params
    else:  # qlora / lora -> adapters only
        trainable = params * max(1e-6, lora_param_fraction)
    trainable_million = trainable / 1e6

    # grads + optimizer for trainable params, sharded under FULL_SHARD
    opt_div = world_size if sharding_strategy in ("FULL_SHARD", "HYBRID_SHARD") else 1
    grad_gib = (trainable * GRAD_BYTES_PER_TRAINABLE) / (1024 ** 3) / max(1, opt_div)
    # full finetune also keeps an fp32 master copy (4 bytes) for the optimizer
    master_bytes = 4.0 if mode == "full" else 0.0
    opt_gib = (trainable * (ADAM_BYTES_PER_TRAINABLE + master_bytes)) / (1024 ** 3) / max(1, opt_div)
    if cpu_offload:
        opt_gib *= 0.05  # optimizer state offloaded to host
        grad_gib *= 0.5

    # --- activations ---
    # heuristic: act_bytes ~ micro_batch * seq_len * hidden * num_layers * 2 (bf16) * c
    # with c folding in attention scratch. Activation checkpointing keeps only
    # layer boundaries -> divide by ~sqrt(num_layers).
    if hidden_size is None or num_layers is None:
        hidden_size, num_layers, hnote = _infer_arch(params_billion)
        notes.append(hnote)
    act_const = 12.0  # empirical multiplier (attn + mlp scratch, bf16)
    raw_act_bytes = micro_batch * seq_len * hidden_size * num_layers * 2 * act_const
    if activation_checkpointing:
        raw_act_bytes /= math.sqrt(max(1, num_layers))
        notes.append("activation checkpointing on: ~1/sqrt(layers) activation memory")
    activations_gib = raw_act_bytes / (1024 ** 3)

    overhead_gib = 2.5 + 0.5 * (1 if world_size > 1 else 0)  # CUDA ctx + NCCL buffers

    total = base_sharded_gib + grad_gib + opt_gib + activations_gib + overhead_gib
    headroom = gpu_mem_gib - total
    fits = headroom > 0

    if not fits:
        notes.append(
            "DOES NOT FIT: add GPUs/nodes (more sharding), enable --cpu-offload, "
            "switch --mode qlora, reduce --seq-len / --micro-batch, or use a larger GPU."
        )

    return MemoryEstimate(
        base_weights_gib=round(base_gib, 2),
        base_weights_sharded_gib=round(base_sharded_gib, 2),
        trainable_params_million=round(trainable_million, 2),
        grads_gib=round(grad_gib, 3),
        optimizer_gib=round(opt_gib, 3),
        activations_gib=round(activations_gib, 2),
        overhead_gib=round(overhead_gib, 2),
        total_per_gpu_gib=round(total, 2),
        fits=fits,
        headroom_gib=round(headroom, 2),
        notes=notes,
    )


# world_size -> nodes is only needed for HYBRID_SHARD intra-node division. We
# stash the topology globally to keep estimate_memory's signature small.
_TOPOLOGY: Dict[str, int] = {"nnodes": 1, "gpus_per_node": 1}


def _nodes_from_world(world_size: int) -> int:
    return max(1, _TOPOLOGY.get("nnodes", 1))


def _infer_arch(params_billion: float) -> Tuple[int, int, str]:
    """Rough (hidden_size, num_layers) for common dense scales.

    Used only for the activation estimate when the user does not pass
    --hidden-size / --num-layers. Conservative middle-of-the-road values.
    """
    table = [
        (8, 4096, 32),
        (13, 5120, 40),
        (32, 5120, 64),
        (34, 7168, 48),
        (70, 8192, 80),
        (72, 8192, 80),
        (110, 8192, 96),
        (180, 14336, 80),
        (405, 16384, 126),
    ]
    best = min(table, key=lambda t: abs(t[0] - params_billion))
    return best[1], best[2], (
        f"inferred arch ~hidden={best[1]} layers={best[2]} for {params_billion:.0f}B "
        f"(pass --hidden-size/--num-layers to override)"
    )


def choose_sharding(
    params_billion: float, mode: str, nnodes: int, requested: str
) -> Tuple[str, List[str]]:
    notes: List[str] = []
    if requested != "auto":
        return requested, notes
    if mode == "full":
        strat = "HYBRID_SHARD" if nnodes > 1 else "FULL_SHARD"
        notes.append(
            f"auto sharding -> {strat} (full finetune; "
            + ("hybrid to cut cross-node all-gather" if nnodes > 1 else "single node")
            + ")"
        )
        return strat, notes
    # qlora/lora: adapters are tiny; FULL_SHARD the frozen base, which is the
    # dominant memory term for >32B.
    strat = "FULL_SHARD"
    notes.append("auto sharding -> FULL_SHARD (adapter training; base dominates memory)")
    return strat, notes


# ---------------------------------------------------------------------------
# Plan construction
# ---------------------------------------------------------------------------
def build_plan(args: argparse.Namespace, trainer_args: List[str]) -> LaunchPlan:
    # --- topology (CLI overrides env overrides defaults) ---
    gpus_per_node = (
        args.gpus_per_node
        if args.gpus_per_node is not None
        else _env_int("NPROC_PER_NODE", None)
        or _env_int("GPUS_PER_NODE", None)
        or 1
    )
    nnodes = (
        args.nodes
        if args.nodes is not None
        else _env_int("NNODES", None) or 1
    )
    node_rank = (
        args.node_rank
        if args.node_rank is not None
        else _env_int("NODE_RANK", None)
        if _env_int("NODE_RANK", None) is not None
        else _env_int("RANK", 0) // max(1, gpus_per_node)
    )
    world_size = (
        args.world_size
        if args.world_size is not None
        else _env_int("WORLD_SIZE", None) or (nnodes * gpus_per_node)
    )
    # keep nnodes consistent with world_size if WORLD_SIZE was authoritative
    if world_size and gpus_per_node:
        derived_nodes = max(1, math.ceil(world_size / gpus_per_node))
        if derived_nodes != nnodes and args.nodes is None:
            nnodes = derived_nodes

    master_addr = args.master_addr or _env_str("MASTER_ADDR", "127.0.0.1")
    master_port = args.master_port or _env_int("MASTER_PORT", 29500)

    _TOPOLOGY["nnodes"] = nnodes
    _TOPOLOGY["gpus_per_node"] = gpus_per_node

    # --- gpu memory ---
    gpu_mem, gpu_notes = resolve_gpu_mem(args.gpu, args.gpu_mem_gib)

    # --- params ---
    params_b, param_notes = infer_params_billion(args.model, args.params_billion)

    # --- sharding strategy ---
    strat, strat_notes = choose_sharding(params_b, args.mode, nnodes, args.sharding)

    # offload defaults: auto-enable CPU offload for full finetune of >70B if it
    # otherwise would not fit. We compute a first estimate, then maybe flip.
    cpu_offload = bool(args.cpu_offload)
    nvme_dir = args.nvme_offload_dir

    mp = args.mixed_precision
    if mp == "auto":
        mp = "bf16"

    mem = estimate_memory(
        params_billion=params_b,
        mode=args.mode,
        world_size=world_size,
        gpu_mem_gib=gpu_mem,
        sharding_strategy=strat,
        cpu_offload=cpu_offload,
        activation_checkpointing=not args.no_activation_checkpointing,
        seq_len=args.seq_len,
        micro_batch=args.micro_batch,
        hidden_size=args.hidden_size,
        num_layers=args.num_layers,
        lora_rank=args.lora_rank,
        lora_param_fraction=args.lora_param_fraction,
    )

    auto_offload_note: List[str] = []
    if not mem.fits and not cpu_offload and not args.no_auto_offload:
        cpu_offload = True
        auto_offload_note.append(
            "plan did not fit on-GPU; auto-enabled --cpu-offload (override with --no-auto-offload)"
        )
        mem = estimate_memory(
            params_billion=params_b,
            mode=args.mode,
            world_size=world_size,
            gpu_mem_gib=gpu_mem,
            sharding_strategy=strat,
            cpu_offload=cpu_offload,
            activation_checkpointing=not args.no_activation_checkpointing,
            seq_len=args.seq_len,
            micro_batch=args.micro_batch,
            hidden_size=args.hidden_size,
            num_layers=args.num_layers,
            lora_rank=args.lora_rank,
            lora_param_fraction=args.lora_param_fraction,
        )

    mem.notes = gpu_notes + param_notes + strat_notes + auto_offload_note + mem.notes

    # --- trainer resolution ---
    trainer = args.trainer
    if trainer in KNOWN_TRAINERS:
        trainer_script = str(Path(__file__).resolve().parent / KNOWN_TRAINERS[trainer])
    else:
        # allow an explicit path
        trainer_script = trainer
    if not args.dry_run and not Path(trainer_script).exists():
        # do not hard-fail in dry-run; in real launch it must exist
        raise FileNotFoundError(f"trainer script not found: {trainer_script}")

    # --- launcher + command ---
    rdzv_id = args.rdzv_id or _env_str("RDZV_ID", "kolm-mn") or "kolm-mn"
    rdzv_backend = args.rdzv_backend

    accel_cfg_path: Optional[str] = None
    if args.launcher == "accelerate":
        accel_cfg = build_accelerate_config(
            nnodes=nnodes,
            gpus_per_node=gpus_per_node,
            node_rank=node_rank,
            master_addr=master_addr,
            master_port=master_port,
            sharding_strategy=strat,
            cpu_offload=cpu_offload,
            mixed_precision=mp,
            activation_checkpointing=not args.no_activation_checkpointing,
        )
        accel_cfg_path = args.accelerate_config_out or str(
            Path(__file__).resolve().parent / "fsdp_config.generated.yaml"
        )
        command = build_accelerate_command(
            config_path=accel_cfg_path,
            nnodes=nnodes,
            gpus_per_node=gpus_per_node,
            node_rank=node_rank,
            master_addr=master_addr,
            master_port=master_port,
            trainer_script=trainer_script,
            trainer_args=trainer_args,
        )
    else:
        command = build_torchrun_command(
            nnodes=nnodes,
            gpus_per_node=gpus_per_node,
            node_rank=node_rank,
            master_addr=master_addr,
            master_port=master_port,
            rdzv_backend=rdzv_backend,
            rdzv_id=rdzv_id,
            trainer_script=trainer_script,
            trainer_args=trainer_args,
        )
        accel_cfg = None

    # Environment the launcher will export so the *trainer subprocess* sees a
    # consistent FSDP config without re-parsing CLI.
    env_overrides = {
        "KOLM_FSDP": "1",
        "KOLM_FSDP_SHARDING": strat,
        "KOLM_FSDP_CPU_OFFLOAD": "1" if cpu_offload else "0",
        "KOLM_FSDP_MIXED_PRECISION": mp,
        "KOLM_FSDP_ACT_CKPT": "0" if args.no_activation_checkpointing else "1",
        "KOLM_TRAIN_MODE": args.mode,
        "MASTER_ADDR": master_addr,
        "MASTER_PORT": str(master_port),
        "OMP_NUM_THREADS": str(args.omp_threads),
        # NCCL hygiene for multi-node InfiniBand/Ethernet fabrics
        "NCCL_ASYNC_ERROR_HANDLING": "1",
        "TORCH_NCCL_ASYNC_ERROR_HANDLING": "1",
    }
    if nvme_dir:
        env_overrides["KOLM_FSDP_NVME_DIR"] = nvme_dir
    if args.nccl_socket_ifname:
        env_overrides["NCCL_SOCKET_IFNAME"] = args.nccl_socket_ifname

    plan = LaunchPlan(
        model=args.model,
        model_params_billion=round(params_b, 2),
        mode=args.mode,
        trainer=trainer,
        trainer_script=trainer_script,
        nnodes=nnodes,
        gpus_per_node=gpus_per_node,
        world_size=world_size,
        node_rank=node_rank,
        master_addr=master_addr,
        master_port=master_port,
        rdzv_backend=rdzv_backend,
        rdzv_id=rdzv_id,
        sharding_strategy=strat,
        cpu_offload=cpu_offload,
        nvme_offload_dir=nvme_dir,
        activation_checkpointing=not args.no_activation_checkpointing,
        mixed_precision=mp,
        gpu=args.gpu,
        gpu_mem_gib=gpu_mem,
        memory=mem,
        launcher=args.launcher,
        accelerate_config_path=accel_cfg_path,
        command=command,
        trainer_args=trainer_args,
        env_overrides=env_overrides,
    )
    # stash generated accelerate config text for the writer / dry-run print
    plan_extra = {"_accelerate_config_text": accel_cfg}
    setattr(plan, "_extra", plan_extra)
    return plan


def build_torchrun_command(
    *,
    nnodes: int,
    gpus_per_node: int,
    node_rank: int,
    master_addr: str,
    master_port: int,
    rdzv_backend: str,
    rdzv_id: str,
    trainer_script: str,
    trainer_args: List[str],
) -> List[str]:
    cmd: List[str] = [
        "torchrun",
        f"--nnodes={nnodes}",
        f"--nproc_per_node={gpus_per_node}",
        f"--node_rank={node_rank}",
    ]
    if nnodes > 1:
        # c10d rendezvous is the recommended multi-node backend
        cmd += [
            f"--rdzv_backend={rdzv_backend}",
            f"--rdzv_id={rdzv_id}",
            f"--rdzv_endpoint={master_addr}:{master_port}",
        ]
    else:
        cmd += [
            f"--master_addr={master_addr}",
            f"--master_port={master_port}",
        ]
    cmd += [trainer_script]
    cmd += trainer_args
    return cmd


def build_accelerate_command(
    *,
    config_path: str,
    nnodes: int,
    gpus_per_node: int,
    node_rank: int,
    master_addr: str,
    master_port: int,
    trainer_script: str,
    trainer_args: List[str],
) -> List[str]:
    cmd: List[str] = [
        "accelerate", "launch",
        f"--config_file={config_path}",
        f"--num_machines={nnodes}",
        f"--num_processes={nnodes * gpus_per_node}",
        f"--machine_rank={node_rank}",
        f"--main_process_ip={master_addr}",
        f"--main_process_port={master_port}",
        trainer_script,
    ]
    cmd += trainer_args
    return cmd


def build_accelerate_config(
    *,
    nnodes: int,
    gpus_per_node: int,
    node_rank: int,
    master_addr: str,
    master_port: int,
    sharding_strategy: str,
    cpu_offload: bool,
    mixed_precision: str,
    activation_checkpointing: bool,
) -> str:
    """Render an accelerate FSDP config (YAML) as text.

    Written to disk only when --launcher accelerate is used and not --dry-run.
    """
    # map our strategy names to accelerate's fsdp_sharding_strategy enum
    strat_map = {
        "FULL_SHARD": 1,
        "SHARD_GRAD_OP": 2,
        "NO_SHARD": 3,
        "HYBRID_SHARD": 4,
    }
    lines = [
        "compute_environment: LOCAL_MACHINE",
        "distributed_type: FSDP",
        f"machine_rank: {node_rank}",
        f"num_machines: {nnodes}",
        f"num_processes: {nnodes * gpus_per_node}",
        f"main_process_ip: {master_addr}",
        f"main_process_port: {master_port}",
        f"mixed_precision: {mixed_precision}",
        "rdzv_backend: c10d" if nnodes > 1 else "rdzv_backend: static",
        "same_network: true",
        "use_cpu: false",
        "fsdp_config:",
        f"  fsdp_sharding_strategy: {strat_map.get(sharding_strategy, 1)}",
        "  fsdp_auto_wrap_policy: TRANSFORMER_BASED_WRAP",
        "  fsdp_backward_prefetch: BACKWARD_PRE",
        "  fsdp_forward_prefetch: false",
        "  fsdp_state_dict_type: SHARDED_STATE_DICT",
        f"  fsdp_offload_params: {str(cpu_offload).lower()}",
        f"  fsdp_activation_checkpointing: {str(activation_checkpointing).lower()}",
        "  fsdp_use_orig_params: true",
        "  fsdp_sync_module_states: true",
        "  fsdp_cpu_ram_efficient_loading: true",
        "  fsdp_limit_all_gathers: true",
    ]
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------
def render_plan_human(plan: LaunchPlan) -> str:
    m = plan.memory
    fit_word = "FITS" if m.fits else "DOES NOT FIT"
    bar = "=" * 72
    out: List[str] = []
    out.append(bar)
    out.append("  Kolmogorov Stack - multi-node / FSDP launch plan (DRY RUN)")
    out.append(bar)
    out.append(f"  model                : {plan.model}  (~{plan.model_params_billion:.0f}B params)")
    out.append(f"  mode                 : {plan.mode}")
    out.append(f"  trainer              : {plan.trainer}  ({plan.trainer_script})")
    out.append("")
    out.append("  TOPOLOGY")
    out.append(f"    nodes              : {plan.nnodes}")
    out.append(f"    gpus / node        : {plan.gpus_per_node}")
    out.append(f"    world size         : {plan.world_size}")
    out.append(f"    this node_rank     : {plan.node_rank}")
    out.append(f"    master             : {plan.master_addr}:{plan.master_port}")
    out.append(f"    rendezvous         : {plan.rdzv_backend} (id={plan.rdzv_id})")
    out.append("")
    out.append("  SHARDING")
    out.append(f"    strategy           : {plan.sharding_strategy}")
    out.append(f"    cpu offload        : {plan.cpu_offload}")
    out.append(f"    nvme offload dir   : {plan.nvme_offload_dir or '-'}")
    out.append(f"    activation ckpt    : {plan.activation_checkpointing}")
    out.append(f"    mixed precision    : {plan.mixed_precision}")
    out.append("")
    out.append(f"  PER-GPU MEMORY ESTIMATE on {plan.gpu} ({plan.gpu_mem_gib:.1f} GiB)")
    out.append(f"    base weights (full): {m.base_weights_gib:>8.2f} GiB")
    out.append(f"    base weights/shard : {m.base_weights_sharded_gib:>8.2f} GiB")
    out.append(f"    trainable params   : {m.trainable_params_million:>8.1f} M")
    out.append(f"    gradients          : {m.grads_gib:>8.3f} GiB")
    out.append(f"    optimizer state    : {m.optimizer_gib:>8.3f} GiB")
    out.append(f"    activations        : {m.activations_gib:>8.2f} GiB")
    out.append(f"    overhead (ctx/nccl): {m.overhead_gib:>8.2f} GiB")
    out.append(f"    --------------------------------------------")
    out.append(f"    TOTAL / GPU        : {m.total_per_gpu_gib:>8.2f} GiB")
    out.append(f"    headroom           : {m.headroom_gib:>8.2f} GiB   [{fit_word}]")
    out.append("")
    if plan.launcher == "accelerate" and plan.accelerate_config_path:
        out.append(f"  GENERATED ACCELERATE CONFIG -> {plan.accelerate_config_path}")
        cfg = getattr(plan, "_extra", {}).get("_accelerate_config_text")
        if cfg:
            for line in cfg.splitlines():
                out.append(f"    | {line}")
        out.append("")
    out.append("  ENV OVERRIDES (exported to the trainer subprocess)")
    for k, v in plan.env_overrides.items():
        out.append(f"    {k}={v}")
    out.append("")
    out.append("  LAUNCH COMMAND")
    out.append("    " + " ".join(shlex.quote(c) for c in plan.command))
    out.append("")
    if m.notes:
        out.append("  NOTES")
        for n in m.notes:
            out.append(f"    - {n}")
        out.append("")
    out.append(bar)
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Launch
# ---------------------------------------------------------------------------
def do_launch(plan: LaunchPlan, args: argparse.Namespace) -> int:
    # Write the accelerate config to disk if needed.
    if plan.launcher == "accelerate" and plan.accelerate_config_path:
        cfg_text = getattr(plan, "_extra", {}).get("_accelerate_config_text")
        if cfg_text:
            Path(plan.accelerate_config_path).write_text(cfg_text, encoding="utf-8")
            print(f"[multinode] wrote accelerate config -> {plan.accelerate_config_path}",
                  file=sys.stderr)

    # Verify the launcher binary exists before exec.
    binary = plan.command[0]
    if shutil.which(binary) is None:
        print(
            f"[multinode] ERROR: '{binary}' not found on PATH. Install it "
            f"(pip install torch / accelerate) or use --launcher to switch.",
            file=sys.stderr,
        )
        return 127

    env = dict(os.environ)
    env.update(plan.env_overrides)

    print(f"[multinode] launching: {' '.join(shlex.quote(c) for c in plan.command)}",
          file=sys.stderr)
    try:
        proc = subprocess.run(plan.command, env=env)
        return proc.returncode
    except KeyboardInterrupt:
        return 130


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="multinode_launch.py",
        description="Multi-node / FSDP launcher for >32B QLoRA / full finetune.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    # model / mode
    p.add_argument("--model", required=True, help="HF model id or local path")
    p.add_argument("--params-billion", type=float, default=None,
                   help="parameter count in billions (override auto-inference)")
    p.add_argument("--mode", choices=["qlora", "lora", "full"], default="qlora",
                   help="training mode")
    p.add_argument("--trainer", default="distill",
                   help="trainer entrypoint: one of "
                        + ", ".join(KNOWN_TRAINERS) + ", or a path to a .py")

    # topology (CLI > env > default)
    p.add_argument("--nodes", "--nnodes", dest="nodes", type=int, default=None,
                   help="number of nodes (env NNODES)")
    p.add_argument("--gpus-per-node", "--nproc-per-node", dest="gpus_per_node",
                   type=int, default=None,
                   help="GPUs per node (env NPROC_PER_NODE / GPUS_PER_NODE)")
    p.add_argument("--world-size", type=int, default=None,
                   help="total processes (env WORLD_SIZE); default nodes*gpus_per_node")
    p.add_argument("--node-rank", type=int, default=None,
                   help="this node's rank (env NODE_RANK)")
    p.add_argument("--master-addr", default=None, help="rendezvous host (env MASTER_ADDR)")
    p.add_argument("--master-port", type=int, default=None,
                   help="rendezvous port (env MASTER_PORT)")
    p.add_argument("--rdzv-backend", default="c10d", help="torchrun rendezvous backend")
    p.add_argument("--rdzv-id", default=None, help="rendezvous job id (env RDZV_ID)")

    # gpu
    p.add_argument("--gpu", default="h100-80gb",
                   help="GPU SKU for the memory estimate; known: "
                        + ", ".join(sorted(GPU_HBM_GIB)))
    p.add_argument("--gpu-mem-gib", type=float, default=None,
                   help="usable HBM per GPU in GiB (override the catalog)")

    # sharding / offload
    p.add_argument("--sharding",
                   choices=["auto", "FULL_SHARD", "SHARD_GRAD_OP", "HYBRID_SHARD", "NO_SHARD"],
                   default="auto", help="FSDP sharding strategy")
    p.add_argument("--cpu-offload", action="store_true",
                   help="offload params+optimizer to host RAM")
    p.add_argument("--no-auto-offload", action="store_true",
                   help="do not auto-enable CPU offload when the plan does not fit")
    p.add_argument("--nvme-offload-dir", default=None,
                   help="directory for NVMe offload (very large full finetunes)")
    p.add_argument("--no-activation-checkpointing", action="store_true",
                   help="disable activation checkpointing (uses more memory)")
    p.add_argument("--mixed-precision", choices=["auto", "bf16", "fp16", "fp32"],
                   default="auto", help="mixed precision policy")

    # memory-estimate inputs
    p.add_argument("--seq-len", type=int, default=4096, help="sequence length")
    p.add_argument("--micro-batch", type=int, default=1,
                   help="per-GPU micro batch size")
    p.add_argument("--hidden-size", type=int, default=None,
                   help="model hidden size (auto-inferred if omitted)")
    p.add_argument("--num-layers", type=int, default=None,
                   help="model layer count (auto-inferred if omitted)")
    p.add_argument("--lora-rank", type=int, default=16, help="LoRA rank")
    p.add_argument("--lora-param-fraction", type=float, default=0.003,
                   help="trainable fraction for LoRA/QLoRA adapters (~0.3%% typical)")

    # launcher
    p.add_argument("--launcher", choices=["torchrun", "accelerate"], default="torchrun",
                   help="distributed launcher to use")
    p.add_argument("--accelerate-config-out", default=None,
                   help="where to write the generated accelerate FSDP config")
    p.add_argument("--omp-threads", type=int, default=8,
                   help="OMP_NUM_THREADS for the trainer subprocess")
    p.add_argument("--nccl-socket-ifname", default=None,
                   help="NCCL_SOCKET_IFNAME for multi-node (e.g. eth0, ib0)")

    # actions
    p.add_argument("--dry-run", action="store_true",
                   help="resolve + print the plan and exit WITHOUT launching")
    p.add_argument("--launch", action="store_true",
                   help="actually launch (default when --dry-run is absent)")
    p.add_argument("--json", action="store_true",
                   help="emit the resolved plan as JSON (machine-readable)")
    return p


def split_argv(argv: List[str]) -> Tuple[List[str], List[str]]:
    """Split CLI args at a literal '--' into (launcher args, trainer args)."""
    if "--" in argv:
        i = argv.index("--")
        return argv[:i], argv[i + 1:]
    return argv, []


def main(argv: Optional[List[str]] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    launcher_argv, trainer_args = split_argv(argv)
    parser = build_argparser()
    args = parser.parse_args(launcher_argv)

    try:
        plan = build_plan(args, trainer_args)
    except FileNotFoundError as e:
        print(f"[multinode] ERROR: {e}", file=sys.stderr)
        return 2

    if args.json:
        d = plan.to_dict()
        # include generated accelerate config text in JSON for completeness
        d["accelerate_config_text"] = getattr(plan, "_extra", {}).get(
            "_accelerate_config_text"
        )
        print(json.dumps(d, indent=2))
    else:
        print(render_plan_human(plan))

    if args.dry_run:
        # never import torch / never launch
        if not plan.memory.fits:
            print("\n[multinode] dry-run: plan DOES NOT FIT as configured "
                  "(see NOTES). No process launched.", file=sys.stderr)
        else:
            print("\n[multinode] dry-run OK: plan resolved, fits on-GPU. "
                  "No process launched.", file=sys.stderr)
        return 0

    return do_launch(plan, args)


if __name__ == "__main__":
    raise SystemExit(main())
