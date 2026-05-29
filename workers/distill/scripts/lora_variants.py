#!/usr/bin/env python3
# workers/distill/scripts/lora_variants.py
#
# W921 — vendored + extended LoRA-variant builder for the SHIPPING distill
# worker. Vendored (not cross-tree imported) from apps/trainer/lora_variants.py
# so the worker stays self-contained, and EXTENDED with:
#   - PiSSA / OLoRA init (init_lora_weights) + the mandatory two-phase save
#     (snapshot pissa_init pre-train, convert at save so the adapter loads on
#     the ORIGINAL base, not the SVD-mutated residual).
#   - GaLore TrainingArguments assembly (optim_target_modules + optim_args) with
#     explicit refusals for the incompatible combos (galore+4bit, layerwise+
#     grad-accum>1).
#   - sample-packing (greedy first-fit) with per-example position_ids +
#     block-diagonal boundary metadata; refuses/falls-back when attention can't
#     enforce example boundaries.
#   - preflight_variant_support: dependency + peft-kwarg probe that FAILS LOUD
#     with an install hint rather than silently degrading.
#
# Nothing here imports peft/torch/transformers at module load — imports happen
# on call, so `python -c "import ast; ast.parse(open(this).read())"` and a
# --preflight import are GPU-free.
#
# References: PiSSA arXiv:2404.02948; DoRA arXiv:2402.09353; rsLoRA
# arXiv:2312.03732; LoRA+ arXiv:2402.12354; NEFTune arXiv:2310.05914; GaLore
# arXiv:2403.03507; packing arXiv:2407.09105.

from __future__ import annotations

import dataclasses
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

# init_lora_weights values PEFT understands. 'default' maps to True.
PISSA_INITS = ("pissa", "pissa_niter_16", "olora")
VALID_INITS = ("default", "gaussian") + PISSA_INITS


@dataclasses.dataclass
class LoraVariantConfig:
    r: int = 16
    lora_alpha: int = 32
    lora_dropout: float = 0.05
    target_modules: Optional[list] = None
    bias: str = "none"
    task_type: str = "CAUSAL_LM"

    # Variants
    use_rslora: bool = False
    use_dora: bool = False
    use_lora_plus: bool = False
    lora_plus_ratio: float = 16.0
    freeze_a: bool = False
    neftune_noise_alpha: Optional[float] = None
    init_lora_weights: str = "default"  # one of VALID_INITS

    def variant_from_name(self, name: str) -> "LoraVariantConfig":
        """Set the boolean variant flags from a variant NAME
        (lora|rslora|dora|loraplus|lora-fa)."""
        name = (name or "lora").lower()
        self.use_rslora = name == "rslora"
        self.use_dora = name == "dora"
        self.use_lora_plus = name == "loraplus"
        self.freeze_a = name == "lora-fa"
        return self


def _peft_init_value(init: str):
    """Map our init string to PEFT's init_lora_weights value."""
    init = (init or "default").lower()
    if init == "default":
        return True
    if init == "gaussian":
        return "gaussian"
    return init  # pissa / pissa_niter_16 / olora pass through verbatim


def build_peft_lora_config(cfg: LoraVariantConfig, *, init_lora_weights=None):
    """Build a PEFT LoraConfig. init_lora_weights overrides cfg.init_lora_weights
    when given. Feature-detects rsLoRA/DoRA/init support and downgrades with a
    logged WARNING (not a crash) on too-old peft for the OPTIONAL flags.

    Note: a PiSSA/OLoRA init request that peft is too old to honor is downgraded
    to default + a warning here; the LOUD refusal lives in
    preflight_variant_support so the caller can choose to abort before spend.
    """
    try:
        from peft import LoraConfig
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "peft is required for LoRA training. Run `pip install 'peft>=0.11'`."
        ) from exc

    init = init_lora_weights if init_lora_weights is not None else cfg.init_lora_weights
    base_kwargs = dict(
        r=cfg.r,
        lora_alpha=cfg.lora_alpha,
        lora_dropout=cfg.lora_dropout,
        bias=cfg.bias,
        task_type=cfg.task_type,
    )
    if cfg.target_modules:
        base_kwargs["target_modules"] = list(cfg.target_modules)

    optional_kwargs: dict = {}
    if cfg.use_rslora:
        optional_kwargs["use_rslora"] = True
    if cfg.use_dora:
        optional_kwargs["use_dora"] = True
    init_val = _peft_init_value(init)
    if init_val is not True:
        optional_kwargs["init_lora_weights"] = init_val

    try:
        return LoraConfig(**base_kwargs, **optional_kwargs)
    except TypeError as exc:
        # Strip one optional flag at a time and retry, logging which we lost.
        for flag in list(optional_kwargs):
            try:
                stripped = {k: v for k, v in optional_kwargs.items() if k != flag}
                logger.warning(
                    "[lora_variants] peft rejected '%s'; retrying without it (%s)",
                    flag, exc,
                )
                return LoraConfig(**base_kwargs, **stripped)
            except TypeError:
                continue
        logger.warning(
            "[lora_variants] peft too old for any optional flag; plain LoRA. %s", exc
        )
        return LoraConfig(**base_kwargs)


def snapshot_pissa_init(peft_model, out_dir: str) -> str:
    """Save the UNTRAINED PiSSA decomposition BEFORE trainer.train(). This is the
    reference the converted adapter is computed against at save time. Returns the
    snapshot path. Only call when init startswith 'pissa' (or 'olora')."""
    import os
    init_dir = os.path.join(out_dir, "pissa_init")
    os.makedirs(init_dir, exist_ok=True)
    # save_pretrained on the freshly-initialized peft model captures B0/A0.
    peft_model.save_pretrained(init_dir)
    logger.info("[lora_variants] snapshotted PiSSA init -> %s", init_dir)
    return init_dir


def convert_pissa_save(peft_model, out_dir: str, pissa_init_path: Optional[str]) -> dict:
    """Save the trained adapter, converting from the residual-relative PiSSA form
    back to a STANDARD LoRA adapter (dW = B*A - B0*A0) so it loads on the
    ORIGINAL published base. Records pissa_converted:true on success.

    When pissa_init_path is None (non-PiSSA run) this is a plain save_pretrained
    and pissa_converted:false."""
    import os
    os.makedirs(out_dir, exist_ok=True)
    if pissa_init_path:
        try:
            peft_model.save_pretrained(
                out_dir,
                path_initial_model_for_weight_conversion=pissa_init_path,
            )
            logger.info("[lora_variants] PiSSA-converted adapter saved -> %s", out_dir)
            return {"pissa_converted": True, "out_dir": out_dir}
        except TypeError:
            # peft too old for the conversion kwarg — save uncoverted + WARN.
            peft_model.save_pretrained(out_dir)
            logger.warning(
                "[lora_variants] peft lacks path_initial_model_for_weight_conversion; "
                "saved UNCONVERTED adapter (it expects the residual base!)"
            )
            return {"pissa_converted": False, "out_dir": out_dir, "warning": "unconverted_pissa"}
    peft_model.save_pretrained(out_dir)
    return {"pissa_converted": False, "out_dir": out_dir}


def _split_lora_plus_params(model, *, ratio: float, base_lr: float):
    """LoRA+ optimizer param-groups: LR(B) = ratio * LR(A)."""
    a_params, b_params, other = [], [], []
    for name, param in model.named_parameters():
        if not param.requires_grad:
            continue
        if ".lora_B." in name:
            b_params.append(param)
        elif ".lora_A." in name:
            a_params.append(param)
        else:
            other.append(param)
    groups = []
    if a_params:
        groups.append({"params": a_params, "lr": base_lr})
    if b_params:
        groups.append({"params": b_params, "lr": base_lr * ratio})
    if other:
        groups.append({"params": other, "lr": base_lr})
    return groups


def apply_freeze_a(model) -> int:
    """LoRA-FA: freeze all .lora_A. parameters. Returns frozen count."""
    n = 0
    for name, param in model.named_parameters():
        if ".lora_A." in name:
            param.requires_grad = False
            n += 1
    return n


def build_optimizer(model, cfg: LoraVariantConfig, *, base_lr: float, weight_decay: float = 0.0, paged_8bit: bool = False):
    """Build an optimizer applying LoRA-FA + LoRA+ when requested. (GaLore is a
    DIFFERENT path — see build_galore_training_args; it goes through
    TrainingArguments.optim, not a hand-built optimizer.)"""
    if cfg.freeze_a:
        apply_freeze_a(model)
    if cfg.use_lora_plus:
        groups = _split_lora_plus_params(model, ratio=cfg.lora_plus_ratio, base_lr=base_lr)
    else:
        groups = [{"params": [p for p in model.parameters() if p.requires_grad], "lr": base_lr}]
    if paged_8bit:
        try:
            from bitsandbytes.optim import PagedAdamW8bit
            return PagedAdamW8bit(groups, weight_decay=weight_decay)
        except Exception as exc:
            logger.warning("[lora_variants] PagedAdamW8bit unavailable (%s); torch.AdamW", exc)
    import torch
    return torch.optim.AdamW(groups, weight_decay=weight_decay)


def neftune_args_patch(args, alpha: Optional[float]) -> None:
    """Patch TrainingArguments in place with neftune_noise_alpha."""
    if alpha is None or alpha <= 0:
        return
    setattr(args, "neftune_noise_alpha", float(alpha))
    logger.info("[lora_variants] NEFTune alpha=%.2f", alpha)


def build_galore_training_args(base_kwargs: dict, *, optim: str, target_modules: list, optim_args: str):
    """Assemble TrainingArguments for a GaLore run: optim + optim_target_modules
    + optim_args. REFUSES the incompatible combos:
      - galore + load_in_4bit (GaLore needs full-precision weights)
      - galore_*_layerwise + grad-accum>1 (single-GPU, no DDP/DeepSpeed)
    Returns a TrainingArguments instance."""
    from transformers import TrainingArguments

    if base_kwargs.get("load_in_4bit") or base_kwargs.get("_qlora"):
        raise RuntimeError(
            "GaLore is incompatible with 4-bit (QLoRA) params — it needs "
            "full-precision weights. Use method=full or a non-galore optim."
        )
    if optim == "galore_adamw_layerwise" and int(base_kwargs.get("gradient_accumulation_steps", 1)) > 1:
        raise RuntimeError(
            "galore_adamw_layerwise requires gradient_accumulation_steps == 1 "
            "(single-GPU, no DDP/DeepSpeed)."
        )
    kwargs = {k: v for k, v in base_kwargs.items() if not k.startswith("_")}
    kwargs.pop("load_in_4bit", None)
    kwargs["optim"] = optim
    kwargs["optim_target_modules"] = list(target_modules)
    if optim_args:
        kwargs["optim_args"] = optim_args
    return TrainingArguments(**kwargs)


def build_packed_dataset(rows: list, tokenizer, max_len: int, eos_id: int):
    """Greedy first-fit packing: concatenate tokenized examples into <=max_len
    blocks, emitting per-example position_ids that RESTART at each example
    boundary (so a boundary-aware attention impl never lets token i attend to
    example j). Returns (Dataset, needs_boundary_aware_attn).

    needs_boundary_aware_attn=True signals the caller MUST use a block-diagonal
    / FlashAttention-2 / padding_free path; if it can't, it should fall back to
    the padded collator (no silent cross-contamination)."""
    from datasets import Dataset

    # Tokenize each example's full text (no padding) -> list of token-id lists.
    packed_input_ids: list = []
    packed_position_ids: list = []
    packed_labels: list = []
    packed_seq_boundaries: list = []  # cumulative example lengths per block

    cur_ids: list = []
    cur_pos: list = []
    cur_bounds: list = []

    def flush():
        nonlocal cur_ids, cur_pos, cur_bounds
        if not cur_ids:
            return
        packed_input_ids.append(list(cur_ids))
        packed_position_ids.append(list(cur_pos))
        packed_labels.append(list(cur_ids))  # causal LM: labels = inputs
        packed_seq_boundaries.append(list(cur_bounds))
        cur_ids, cur_pos, cur_bounds = [], [], []

    for row in rows:
        ids = row["input_ids"] if isinstance(row, dict) and "input_ids" in row else row
        ids = list(ids)[:max_len]
        if eos_id is not None and (not ids or ids[-1] != eos_id):
            ids = ids + [eos_id]
        ids = ids[:max_len]
        if len(cur_ids) + len(ids) > max_len:
            flush()
        cur_bounds.append(len(ids))
        cur_pos.extend(range(len(ids)))  # position_ids RESTART per example
        cur_ids.extend(ids)
    flush()

    ds = Dataset.from_dict({
        "input_ids": packed_input_ids,
        "position_ids": packed_position_ids,
        "labels": packed_labels,
        "seq_boundaries": packed_seq_boundaries,
    })
    return ds, True


def preflight_variant_support(lora_init: str, optim: str) -> dict:
    """Probe dependency + peft-kwarg support for the requested variant/optim.
    Returns {ok, missing:[...], hints:[...]} so the caller can FAIL LOUD before
    spending teacher/GPU time."""
    missing: list = []
    hints: list = []

    lora_init = (lora_init or "default").lower()
    optim = (optim or "adamw_torch").lower()

    # peft + PiSSA kwarg support.
    if lora_init in PISSA_INITS:
        try:
            import inspect
            from peft import LoraConfig  # noqa: F401
            sig = inspect.signature(LoraConfig.__init__)
            if "init_lora_weights" not in sig.parameters:
                missing.append("peft.init_lora_weights")
                hints.append("upgrade peft: pip install -U 'peft>=0.11' (PiSSA/OLoRA init)")
        except ImportError:
            missing.append("peft")
            hints.append("pip install 'peft>=0.11'")

    # GaLore importability.
    if optim.startswith("galore"):
        try:
            import galore_torch  # noqa: F401
        except ImportError:
            missing.append("galore-torch")
            hints.append("pip install galore-torch  (required for KOLM_OPTIM=galore_*)")

    return {"ok": len(missing) == 0, "missing": missing, "hints": hints,
            "lora_init": lora_init, "optim": optim}


__all__ = [
    "LoraVariantConfig",
    "VALID_INITS",
    "PISSA_INITS",
    "build_peft_lora_config",
    "snapshot_pissa_init",
    "convert_pissa_save",
    "build_optimizer",
    "neftune_args_patch",
    "build_galore_training_args",
    "build_packed_dataset",
    "preflight_variant_support",
]
