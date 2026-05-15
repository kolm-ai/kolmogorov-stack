"""
apps/trainer/federated.py

Federated training of LoRA adapters with secure aggregation.

The unblocking use case is the multi-org consortium. Two hospitals want to
co-train a PHI redactor that knows their joint vocabulary. They are legally
forbidden from sharing patient data. Federated learning is the answer: each
hospital trains locally on its own data, sends only the adapter weight delta
to an aggregator, and the aggregator averages deltas to produce the next
global round.

Secure aggregation (Bonawitz et al, 2017) goes one step further: each client
masks its delta with a random pad that pairwise cancels across clients, so
the aggregator only sees the sum, never any individual update. We implement
a pragmatic version: per-pair PRG-derived masks over selected tensors, plus
optional differential-privacy noise on each delta. Production hardening adds
threshold dropout recovery (Shamir secret sharing) — out of scope here.

LoRA is the right adapter shape for federated work because the delta is
tiny (50 MB vs 7 GB for a full model), so per-round bandwidth is reasonable
even when clients are on hospital intranets.

References:

  * McMahan et al, 2017. "Communication-Efficient Learning of Deep Networks
    from Decentralized Data." arXiv:1602.05629. FedAvg.
  * Bonawitz et al, 2017. "Practical Secure Aggregation for Privacy-Preserving
    Machine Learning." CCS 2017. The masking scheme.
  * Beutel et al, 2020. "Flower: A Friendly Federated Learning Research
    Framework." arXiv:2007.14390. The protocol shapes we mirror.
  * Sun et al, 2024. "FedKSeed." For LoRA-specific federated reductions.

Surface:

    from apps.trainer.federated import federated_round, FederatedConfig

    # On each client:
    delta = client_step(model, dataset, cfg)
    masked = mask_delta(delta, peer_pubkeys, my_seed, cfg)
    send_to_aggregator(masked)

    # On the aggregator:
    global_delta = aggregate(masked_deltas)
    new_global = apply_delta(global_global_state, global_delta)
"""

from __future__ import annotations

import copy
import hashlib
import hmac
import json
import os
import secrets
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Optional, Any, Iterable

try:
    import torch
    import torch.nn as nn
except ImportError as e:
    raise ImportError(
        "federated.py needs torch. pip install 'torch>=2.4,<2.9'."
    ) from e


@dataclass
class FederatedConfig:
    """Per-round federated knobs.

    `dp_sigma` adds Gaussian noise to each client delta before aggregation.
    Setting it to 0 disables DP. Real production should pick sigma against a
    target epsilon via an accountant; we leave that to the operator.
    """

    rounds: int = 5
    client_epochs: int = 1
    client_lr: float = 1e-4
    client_batch_size: int = 8
    secure_aggregation: bool = True
    dp_sigma: float = 0.0
    dp_clip: float = 1.0
    aggregator_quorum: int = 2
    server_lr: float = 1.0
    seed: int = 42


def lora_state_dict(model) -> dict:
    """Pull out only the LoRA parameters from a peft-wrapped model.

    The federated rounds work on this dict, never the full base weights.
    """

    out = {}
    for name, p in model.named_parameters():
        if "lora_" in name and p.requires_grad:
            out[name] = p.detach().clone()
    if not out:
        raise ValueError("federated.py: no LoRA tensors found. Wrap the model with peft first.")
    return out


def delta(before: dict, after: dict) -> dict:
    """Compute the per-tensor delta `after - before` for LoRA parameters."""

    if set(before.keys()) != set(after.keys()):
        raise ValueError("federated.py: tensor key set mismatch between rounds.")
    return {k: (after[k] - before[k]) for k in before}


def clip_l2(delta_dict: dict, clip: float) -> dict:
    """Global L2 clip across all tensors in the delta.

    Required before DP noise so the sensitivity is bounded.
    """

    flat = torch.cat([v.flatten() for v in delta_dict.values()])
    norm = flat.norm(p=2)
    factor = min(1.0, clip / (norm + 1e-12))
    return {k: v * factor for k, v in delta_dict.items()}


def add_dp_noise(delta_dict: dict, sigma: float, generator: Optional[torch.Generator] = None) -> dict:
    """Add zero-mean Gaussian noise of std `sigma` to each tensor.

    Combined with clip_l2, this gives (epsilon, delta)-DP per the standard
    Gaussian mechanism. Caller is responsible for the privacy accountant.
    """

    if sigma <= 0:
        return delta_dict
    out = {}
    for k, v in delta_dict.items():
        noise = torch.empty_like(v).normal_(mean=0.0, std=sigma, generator=generator)
        out[k] = v + noise
    return out


def derive_pairwise_mask(my_id: bytes, peer_id: bytes, shared_seed: bytes, shape: torch.Size, dtype: torch.dtype) -> torch.Tensor:
    """PRG-derive a deterministic float tensor from (my_id, peer_id, shared_seed).

    The two clients in a pair sample the same mask; one adds it, the other
    subtracts. Across the sum, the masks cancel and the aggregator sees only
    the legitimate sum of deltas.
    """

    lo, hi = sorted([my_id, peer_id])
    mac = hmac.new(shared_seed, lo + b"|" + hi, hashlib.sha256).digest()
    seed_int = int.from_bytes(mac[:8], "big")
    gen = torch.Generator()
    gen.manual_seed(seed_int)
    return torch.empty(shape, dtype=dtype).normal_(mean=0.0, std=1.0, generator=gen)


def mask_delta(delta_dict: dict, my_id: bytes, peer_ids: list[bytes], shared_seed: bytes) -> dict:
    """Apply pairwise masks to each tensor.

    For each peer, derive a deterministic mask and add it if my_id < peer_id,
    subtract otherwise. The sum across all clients then cancels every mask
    by construction, leaving only the true sum.
    """

    masked = {k: v.clone() for k, v in delta_dict.items()}
    for peer in peer_ids:
        if peer == my_id:
            continue
        sign = 1.0 if my_id < peer else -1.0
        for k, v in delta_dict.items():
            mask = derive_pairwise_mask(my_id, peer, shared_seed, v.shape, v.dtype)
            masked[k] = masked[k] + sign * mask
    return masked


def aggregate(masked_deltas: list[dict], server_lr: float = 1.0) -> dict:
    """Sum across clients (the masks cancel by construction) and average.

    Returns the global update to apply to the previous global LoRA state.
    """

    if not masked_deltas:
        raise ValueError("federated.py: aggregate called with no client deltas.")
    keys = set(masked_deltas[0].keys())
    for d in masked_deltas[1:]:
        if set(d.keys()) != keys:
            raise ValueError("federated.py: client tensor key sets disagree.")
    n = len(masked_deltas)
    out = {}
    for k in keys:
        s = torch.zeros_like(masked_deltas[0][k])
        for d in masked_deltas:
            s = s + d[k]
        out[k] = (server_lr / n) * s
    return out


def apply_delta(state: dict, delta_dict: dict) -> dict:
    """Apply an aggregated delta to a global state dict.

    Returns a new dict so the caller controls when to swap in.
    """

    if set(state.keys()) != set(delta_dict.keys()):
        raise ValueError("federated.py: state and delta keys disagree.")
    return {k: state[k] + delta_dict[k] for k in state}


def client_step(model, optimizer, dataloader, epochs: int, device) -> None:
    """One client's local training pass.

    Mutates the model in-place. Caller diffs against the pre-step state to
    produce the federated delta.
    """

    model.train()
    for _ in range(epochs):
        for batch in dataloader:
            optimizer.zero_grad()
            batch = {k: v.to(device) if hasattr(v, "to") else v for k, v in batch.items()}
            out = model(**batch)
            loss = out.loss if hasattr(out, "loss") else out["loss"]
            loss.backward()
            optimizer.step()


def federated_round(
    client_sessions: list[dict],
    global_state: dict,
    cfg: FederatedConfig,
    shared_seed: bytes,
) -> dict:
    """Run one federated round.

    `client_sessions` is a list of {id, model, optimizer, dataloader, device}.
    Each client trains, computes its delta against the global state, optionally
    clips + DP-noises, masks, and the aggregator sums.

    Returns the new global state. The masks cancel across clients only if
    every client participates — partial-dropout recovery is a Shamir layer
    on top, not implemented here.
    """

    client_ids = [s["id"] for s in client_sessions]
    if len(client_ids) < cfg.aggregator_quorum:
        raise ValueError(
            f"federated.py: need at least {cfg.aggregator_quorum} clients; got {len(client_ids)}"
        )

    masked = []
    for sess in client_sessions:
        before = {k: v.clone() for k, v in lora_state_dict(sess["model"]).items()}
        client_step(
            sess["model"],
            sess["optimizer"],
            sess["dataloader"],
            cfg.client_epochs,
            sess["device"],
        )
        after = lora_state_dict(sess["model"])
        d = delta(before, after)
        if cfg.dp_sigma > 0 or cfg.dp_clip < float("inf"):
            d = clip_l2(d, cfg.dp_clip)
        if cfg.dp_sigma > 0:
            d = add_dp_noise(d, cfg.dp_sigma)
        if cfg.secure_aggregation:
            d = mask_delta(d, sess["id"], client_ids, shared_seed)
        masked.append(d)

    update = aggregate(masked, server_lr=cfg.server_lr)
    new_global = apply_delta(global_state, update)

    # Sync each client's local model to the new global state for the next
    # round. Without this the deltas grow unboundedly.
    for sess in client_sessions:
        params = dict(sess["model"].named_parameters())
        for k, v in new_global.items():
            if k in params and params[k].shape == v.shape:
                params[k].data.copy_(v)

    return new_global


def receipt_block(
    cfg: FederatedConfig,
    n_clients: int,
    rounds_completed: int,
    final_loss: Optional[float] = None,
) -> dict:
    return {
        "method": "federated_lora",
        "config": asdict(cfg),
        "n_clients": n_clients,
        "rounds_completed": rounds_completed,
        "final_loss": final_loss,
        "papers": [
            "arXiv:1602.05629",  # FedAvg
            "Bonawitz CCS 2017",  # secure aggregation
            "arXiv:2007.14390",  # Flower
        ],
    }
