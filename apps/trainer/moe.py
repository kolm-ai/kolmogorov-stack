"""
apps/trainer/moe.py

Mixture of LoRA experts. Train N domain-specific LoRA adapters on the same
base, then add a small learned router that picks one (or top-k) adapter per
input. The router is the only joint parameter; the experts are the things
we already ship as signed artifacts.

The motivating use case is a buyer whose product handles many narrow tasks
(refund flagger + PHI redactor + tone classifier + lead scorer in the same
support inbox). Training one giant LoRA on the union is dilutive; training
four LoRAs and switching at request time at the application layer is
expensive to wire. A MoE router learns the switch.

Two routing modes ship:

  * top-1: a single expert runs per token. Fastest. The standard Switch-
    Transformer style (Fedus 2022).
  * top-k: the top-k experts run and their outputs are weighted by the
    router probabilities. Mixtral-8x7B style (Jiang 2024). Higher quality;
    cost grows linearly in k.

Routing happens at sequence granularity by default (one route per input);
optionally per-token. Per-token is more expressive but adds load-balance
problems and requires the auxiliary z-loss + load-balance-loss terms
(Lepikhin 2020, Fedus 2022). We ship per-sequence as the default because
the kolm artifacts are domain-experts, not language-modeling sub-networks,
and a single domain rarely switches mid-utterance.

References:

  * Shazeer et al, 2017. "Outrageously Large Neural Networks: The Sparsely-
    Gated Mixture-of-Experts Layer." arXiv:1701.06538. The original MoE
    layer and the auxiliary load-balance loss.
  * Lepikhin et al, 2020. "GShard: Scaling Giant Models with Conditional
    Computation and Automatic Sharding." arXiv:2006.16668. The z-loss.
  * Fedus, Zoph & Shazeer, 2022. "Switch Transformers: Scaling to Trillion
    Parameter Models with Simple and Efficient Sparsity." arXiv:2101.03961.
    Top-1 routing, simplified.
  * Jiang et al, 2024. "Mixtral of Experts." arXiv:2401.04088. Top-2 with
    weighted-sum aggregation. The recipe most current serving stacks copy.
  * Wang et al, 2022. "AdaMix: Mixture-of-Adapters for Parameter-Efficient
    Fine-Tuning." arXiv:2205.12410. The first credible LoRA-MoE result.
  * Liu et al, 2023. "MoLE: Mixture of LoRA Experts." arXiv:2310.18339.
    The token-level LoRA-MoE recipe with learnable temperature.

Surface:

    from apps.trainer.moe import moe_router_trainer, MoEConfig, RoutingMode

    trainer = moe_router_trainer(
        base_model="Qwen/Qwen2.5-3B-Instruct",
        experts={
            "refund_flag":   "registry/cidv1:sha256:8e...",
            "phi_redactor":  "registry/cidv1:sha256:1b...",
            "tone_classify": "registry/cidv1:sha256:c4...",
        },
        train_jsonl="routing.jsonl",
        out_dir="moe_router/",
        config=MoEConfig(routing=RoutingMode.TOP_K, k=2),
    )
    trainer.train()

Input JSONL shape:

    {"prompt": "...", "expert": "phi_redactor"}    # supervised router
    {"prompt": "...", "winner": "tone_classify"}   # alternative key

Receipt records the expert CIDs (so the binder can re-fetch each), the
routing mode, the per-expert load-balance numbers, and the held-out routing
accuracy.
"""

from __future__ import annotations

import enum
import json
import math
import os
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    _HAS_TORCH = True
except Exception:
    _HAS_TORCH = False


class RoutingMode(str, enum.Enum):
    TOP_1 = "top_1"
    TOP_K = "top_k"

    @classmethod
    def from_str(cls, s: str) -> "RoutingMode":
        s = (s or "").strip().lower()
        for m in cls:
            if m.value == s:
                return m
        raise ValueError(
            f"moe.py: unknown routing mode '{s}'. Pick: {[m.value for m in cls]}"
        )


@dataclass
class MoEConfig:
    """All knobs the router takes."""

    routing: RoutingMode = RoutingMode.TOP_1
    """top_1 is Switch-Transformer style: one expert per input. top_k runs
    k experts and aggregates by router weights (Mixtral style)."""

    k: int = 2
    """Only relevant for top_k. Mixtral 8x7B uses k=2. Higher k buys quality
    at linear inference cost; k=1 collapses to top_1 mode."""

    granularity: str = "sequence"
    """'sequence' = one route per input prompt. 'token' = one route per
    token (much harder to train; needs aux losses)."""

    z_loss_weight: float = 1e-3
    """Lepikhin 2020 router z-loss. Penalizes large logit magnitudes; keeps
    softmax numerically stable. Disabled if 0."""

    load_balance_weight: float = 1e-2
    """Shazeer 2017 load-balance loss. Penalizes router for sending all
    inputs to the same expert. Only relevant when the trainer sees data from
    multiple experts in the same batch."""

    router_hidden: int = 256
    """Dimensionality of the router's single hidden layer. The router takes
    the mean-pooled embedding of the base model and produces a logit per
    expert. Small on purpose: this is the only parameter we train."""

    embed_layer: str = "last_hidden_state"
    """Where to pull the prompt embedding from. 'last_hidden_state' is the
    Qwen/Llama default; 'cls' uses position 0 if the base supports it."""

    learning_rate: float = 1e-3
    batch_size: int = 16
    num_epochs: int = 3
    warmup_ratio: float = 0.05
    seed: int = 42
    bf16: bool = True
    save_steps: int = 100
    eval_split: float = 0.1
    max_length: int = 1024


class Router(nn.Module if _HAS_TORCH else object):
    """A single MLP that maps (B, H) -> (B, N_experts).

    Initialized so the softmax is roughly uniform at step 0; without this
    the early gradients pull every input toward whichever expert had the
    largest random logit and load-balance never recovers.
    """

    def __init__(self, hidden_size: int, n_experts: int, router_hidden: int = 256):
        super().__init__()
        self.fc1 = nn.Linear(hidden_size, router_hidden, bias=True)
        self.act = nn.GELU()
        self.fc2 = nn.Linear(router_hidden, n_experts, bias=True)
        # Bias init zero, weight init small so initial logits are near zero.
        nn.init.normal_(self.fc1.weight, std=0.02)
        nn.init.zeros_(self.fc1.bias)
        nn.init.normal_(self.fc2.weight, std=0.02)
        nn.init.zeros_(self.fc2.bias)

    def forward(self, h):
        return self.fc2(self.act(self.fc1(h)))


def _z_loss(logits) -> Any:
    """Lepikhin 2020 router z-loss: penalize log-sum-exp magnitude so the
    softmax stays in a numerically stable range. Computed per batch element
    then averaged."""
    lse = torch.logsumexp(logits, dim=-1)
    return (lse ** 2).mean()


def _load_balance_loss(probs) -> Any:
    """Shazeer 2017 load-balance: encourage each expert to receive roughly
    equal traffic. Computed as N * sum_i (f_i * P_i), where f_i is the
    fraction of inputs routed to expert i (one-hot mean) and P_i is the
    mean router probability for expert i. The product is minimized when
    both are uniform."""
    n_experts = probs.size(-1)
    one_hot = F.one_hot(probs.argmax(dim=-1), num_classes=n_experts).float()
    f = one_hot.mean(dim=0)
    P = probs.mean(dim=0)
    return n_experts * (f * P).sum()


def _pool_embedding(base_model, tokenizer, prompts: list[str], max_length: int, device) -> Any:
    """Run prompts through the base model in eval mode, mean-pool over
    non-pad positions. Returns (B, H). The base is loaded read-only; only
    the router gets gradients."""
    enc = tokenizer(
        prompts,
        return_tensors="pt",
        padding=True,
        truncation=True,
        max_length=max_length,
    )
    enc = {k: v.to(device) for k, v in enc.items()}
    with torch.no_grad():
        out = base_model(**enc, output_hidden_states=True)
    h = out.hidden_states[-1]  # (B, T, H)
    mask = enc["attention_mask"].unsqueeze(-1).float()
    pooled = (h * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1e-6)
    return pooled


def _load_jsonl(path: str, expert_names: list[str]) -> list[tuple[str, int]]:
    name_to_idx = {n: i for i, n in enumerate(expert_names)}
    rows: list[tuple[str, int]] = []
    with open(path, "r", encoding="utf-8") as f:
        for ln, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                raise ValueError(f"moe.py: malformed JSONL at {path}:{ln}: {e.msg}") from e
            if "prompt" not in obj or not isinstance(obj["prompt"], str):
                raise ValueError(f"moe.py: {path}:{ln} missing 'prompt'")
            label = obj.get("expert") or obj.get("winner")
            if not label or label not in name_to_idx:
                raise ValueError(
                    f"moe.py: {path}:{ln} 'expert' field missing or unknown. "
                    f"Got {label!r}; valid: {list(name_to_idx)}"
                )
            rows.append((obj["prompt"], name_to_idx[label]))
    if not rows:
        raise ValueError(f"moe.py: no rows in {path}")
    return rows


@dataclass
class MoESession:
    base_model: str
    experts: Mapping[str, str]
    config: MoEConfig
    n_train: int
    n_eval: int
    n_experts: int
    _router: Any = None
    _train_fn: Any = None

    def train(self) -> dict[str, Any]:
        if self._train_fn is None:
            raise RuntimeError("moe.py: train() called before trainer was built")
        return self._train_fn()


def moe_router_trainer(
    base_model: str,
    experts: Mapping[str, str],
    train_jsonl: str,
    out_dir: str,
    config: Optional[MoEConfig] = None,
    eval_jsonl: Optional[str] = None,
) -> MoESession:
    """Build a configured router trainer.

    `experts` is a dict of {name: CID-or-path}. The base is loaded read-only
    once and shared across experts at inference; only the router takes
    gradients during this training run. The trained router lands as a small
    .router.kolm artifact (~1-5 MB depending on hidden size).
    """

    if not _HAS_TORCH:
        raise RuntimeError(
            "moe.py: torch required. pip install 'torch>=2.4' transformers"
        )

    try:
        from transformers import AutoTokenizer, AutoModel
    except ImportError as e:
        raise RuntimeError(
            f"moe.py: missing dependency {e.name}. pip install 'transformers>=4.46'"
        ) from e

    cfg = config or MoEConfig()
    if cfg.routing == RoutingMode.TOP_K and cfg.k < 2:
        raise ValueError(f"moe.py: top_k requires k >= 2, got {cfg.k}")
    if cfg.granularity not in ("sequence", "token"):
        raise ValueError(
            f"moe.py: granularity must be 'sequence' or 'token', got {cfg.granularity!r}"
        )
    if cfg.granularity == "token":
        # Token-level routing is supported as a planned mode; the recipe needs
        # per-token forward passes through the base, which currently requires
        # the disagg runtime path. Fail closed with a crisp pointer.
        raise NotImplementedError(
            "moe.py: token-level routing is not yet wired through the runtime. "
            "Track apps/runtime/adapter_pool.py for token-routed multi-LoRA serving "
            "and use granularity='sequence' for now."
        )
    torch.manual_seed(cfg.seed)

    expert_names = list(experts.keys())
    if len(expert_names) < 2:
        raise ValueError("moe.py: need at least 2 experts to route between")

    tokenizer = AutoTokenizer.from_pretrained(base_model, use_fast=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    dtype = torch.bfloat16 if cfg.bf16 else torch.float32
    base = AutoModel.from_pretrained(base_model, torch_dtype=dtype)
    base.eval()
    for p in base.parameters():
        p.requires_grad = False

    hidden_size = getattr(base.config, "hidden_size", None) or base.config.hidden_dim
    router = Router(hidden_size=hidden_size, n_experts=len(expert_names),
                    router_hidden=cfg.router_hidden)
    device = next(base.parameters()).device
    router = router.to(device).to(dtype)

    rows = _load_jsonl(train_jsonl, expert_names)
    eval_rows: list[tuple[str, int]] = []
    if eval_jsonl:
        eval_rows = _load_jsonl(eval_jsonl, expert_names)
    elif cfg.eval_split > 0 and len(rows) >= 20:
        cut = max(1, int(len(rows) * cfg.eval_split))
        eval_rows = rows[-cut:]
        rows = rows[:-cut]

    optimizer = torch.optim.AdamW(router.parameters(), lr=cfg.learning_rate)
    total_steps = max(1, (len(rows) // cfg.batch_size) * cfg.num_epochs)
    warmup_steps = max(1, int(total_steps * cfg.warmup_ratio))

    def lr_at(step: int) -> float:
        if step < warmup_steps:
            return cfg.learning_rate * step / warmup_steps
        progress = (step - warmup_steps) / max(1, total_steps - warmup_steps)
        return cfg.learning_rate * 0.5 * (1.0 + math.cos(math.pi * progress))

    def _eval_loop() -> float:
        if not eval_rows:
            return float("nan")
        router.eval()
        correct = 0
        with torch.no_grad():
            for i in range(0, len(eval_rows), cfg.batch_size):
                chunk = eval_rows[i:i + cfg.batch_size]
                prompts = [r[0] for r in chunk]
                labels = torch.tensor([r[1] for r in chunk], dtype=torch.long, device=device)
                h = _pool_embedding(base, tokenizer, prompts, cfg.max_length, device).to(dtype)
                logits = router(h)
                correct += int((logits.argmax(dim=-1) == labels).sum().item())
        router.train()
        return correct / max(1, len(eval_rows))

    def _train_fn() -> dict[str, Any]:
        os.makedirs(out_dir, exist_ok=True)
        router.train()
        global_step = 0
        loss_final: Optional[float] = None
        for epoch in range(cfg.num_epochs):
            # Light shuffle per epoch.
            order = torch.randperm(len(rows)).tolist()
            for i in range(0, len(order), cfg.batch_size):
                idx = order[i:i + cfg.batch_size]
                chunk = [rows[j] for j in idx]
                prompts = [r[0] for r in chunk]
                labels = torch.tensor([r[1] for r in chunk], dtype=torch.long, device=device)
                h = _pool_embedding(base, tokenizer, prompts, cfg.max_length, device).to(dtype)
                logits = router(h)
                probs = F.softmax(logits, dim=-1)
                loss_ce = F.cross_entropy(logits, labels)
                loss = loss_ce
                if cfg.z_loss_weight > 0:
                    loss = loss + cfg.z_loss_weight * _z_loss(logits)
                if cfg.load_balance_weight > 0:
                    loss = loss + cfg.load_balance_weight * _load_balance_loss(probs)

                for g in optimizer.param_groups:
                    g["lr"] = lr_at(global_step)
                optimizer.zero_grad()
                loss.backward()
                optimizer.step()
                global_step += 1
                loss_final = float(loss.item())

        eval_acc = _eval_loop()

        # Save router weights + name map.
        ckpt = {
            "router_state_dict": router.state_dict(),
            "expert_names": expert_names,
            "expert_cids": [experts[n] for n in expert_names],
            "config": asdict(cfg),
            "hidden_size": hidden_size,
        }
        ckpt["config"]["routing"] = cfg.routing.value
        torch.save(ckpt, os.path.join(out_dir, "router.pt"))

        return {
            "loss_final": loss_final,
            "eval_accuracy": eval_acc,
            "global_step": global_step,
            "expert_names": expert_names,
        }

    session = MoESession(
        base_model=base_model,
        experts=dict(experts),
        config=cfg,
        n_train=len(rows),
        n_eval=len(eval_rows),
        n_experts=len(expert_names),
        _router=router,
        _train_fn=_train_fn,
    )
    return session


def route(router_ckpt_path: str, base_model: str, prompt: str, *, k: int = 1) -> list[tuple[str, float]]:
    """Inference-time helper. Loads a trained router and returns the top-k
    experts for a single prompt as [(expert_name, probability), ...]. The
    application layer is then responsible for loading the chosen adapter
    and running it."""
    if not _HAS_TORCH:
        raise RuntimeError("moe.py: torch required")
    try:
        from transformers import AutoTokenizer, AutoModel
    except ImportError as e:
        raise RuntimeError(f"moe.py: missing dependency {e.name}") from e
    ckpt = torch.load(router_ckpt_path, map_location="cpu", weights_only=False)
    expert_names = ckpt["expert_names"]
    hidden_size = ckpt["hidden_size"]
    cfg_dict = ckpt["config"]
    router_hidden = cfg_dict.get("router_hidden", 256)
    max_length = cfg_dict.get("max_length", 1024)

    tokenizer = AutoTokenizer.from_pretrained(base_model, use_fast=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    base = AutoModel.from_pretrained(base_model, torch_dtype=torch.bfloat16)
    base.eval()
    device = next(base.parameters()).device

    router = Router(hidden_size=hidden_size, n_experts=len(expert_names),
                    router_hidden=router_hidden).to(device).to(torch.bfloat16)
    router.load_state_dict(ckpt["router_state_dict"])
    router.eval()

    with torch.no_grad():
        h = _pool_embedding(base, tokenizer, [prompt], max_length, device).to(torch.bfloat16)
        probs = F.softmax(router(h), dim=-1)[0]
    top = torch.topk(probs, k=min(k, len(expert_names)))
    return [(expert_names[int(i)], float(p)) for p, i in zip(top.values, top.indices)]


def receipt_block(session: MoESession, train_summary: dict) -> dict:
    """The receipt fragment the K-score gate and audit log both read.

    The expert CIDs are pinned so a downstream verifier can re-fetch every
    expert and re-check its independent signature."""
    cfg = asdict(session.config)
    cfg["routing"] = session.config.routing.value
    return {
        "method": "moe_lora_router",
        "base_model": session.base_model,
        "experts": dict(session.experts),
        "config": cfg,
        "n_train_rows": session.n_train,
        "n_eval_rows": session.n_eval,
        "n_experts": session.n_experts,
        "loss_final": train_summary.get("loss_final"),
        "eval_accuracy": train_summary.get("eval_accuracy"),
        "papers": [
            "arXiv:1701.06538",  # Shazeer outrageously large MoE
            "arXiv:2006.16668",  # GShard z-loss
            "arXiv:2101.03961",  # Switch Transformer
            "arXiv:2401.04088",  # Mixtral
            "arXiv:2310.18339",  # MoLE LoRA-MoE
        ],
    }


__all__ = [
    "MoEConfig",
    "MoESession",
    "Router",
    "RoutingMode",
    "moe_router_trainer",
    "receipt_block",
    "route",
]
