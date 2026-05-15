"""
apps/trainer/preference.py

Modern preference-optimization stages, drop-in replacements for DPO.

DPO (Rafailov et al, 2023, arXiv:2305.18290) was the first practical
single-stage preference algorithm. It is still good, but every newer method
beats it on at least one axis. This module exposes the family under one
selector so a spec can ask for the right one without the user reading five
papers.

The trainer surface is:

    from apps.trainer.preference import preference_trainer, PreferenceMethod

    trainer = preference_trainer(
        method=PreferenceMethod.ORPO,           # or DPO / KTO / SIMPO / IPO
        model=peft_model,
        tokenizer=tokenizer,
        train_dataset=preference_dataset,
        eval_dataset=None,
        args=...,                                # transformers.TrainingArguments
        beta=0.1,
        method_kwargs={},
    )
    trainer.train()

Methods:

    DPO     baseline (trl.DPOTrainer)             beta=0.1
    KTO     binary signals, no preference pairs   beta=0.1, kl_loss_type='kl'
    ORPO    single-step preference + SFT          beta=0.1, lambda_=0.1
    SIMPO   reference-free DPO                    beta=2.0, gamma_beta_ratio=0.5
    IPO     identity preference (Azar 2023)       beta=0.1, label_smoothing=0.0

Selection guide:

    method   data shape                       cost          use when
    ----------------------------------------------------------------
    DPO      (chosen, rejected) pairs         baseline      you have clean pairs and a reference model already loaded
    KTO      (output, label in {good, bad})   1x baseline   labels are independent good/bad, no pairs
    ORPO     (prompt, chosen, rejected)       0.5x baseline you also want SFT in the same pass (no SFT->DPO two-stage)
    SIMPO    (chosen, rejected) pairs         0.7x baseline VRAM-tight: no reference model
    IPO      (chosen, rejected) pairs         baseline      DPO overfit to deterministic preferences

All methods land in trl. We do not re-implement the loss; we configure trl's
trainers correctly and fail closed if the version is too old to support the
method.

Citations:
  DPO:   Rafailov et al 2023, arXiv:2305.18290
  KTO:   Ethayarajh et al 2024, arXiv:2402.01306
  ORPO:  Hong et al 2024, arXiv:2403.07691
  SimPO: Meng et al 2024, arXiv:2405.14734
  IPO:   Azar et al 2023, arXiv:2310.12036
"""

from __future__ import annotations

import dataclasses
import enum
import logging
from typing import Any, Mapping, Optional

logger = logging.getLogger(__name__)


class PreferenceMethod(str, enum.Enum):
    DPO = "dpo"
    KTO = "kto"
    ORPO = "orpo"
    SIMPO = "simpo"
    IPO = "ipo"

    @classmethod
    def from_str(cls, s: str) -> "PreferenceMethod":
        s = (s or "").strip().lower()
        for m in cls:
            if m.value == s:
                return m
        raise ValueError(
            f"unknown preference method '{s}'. Pick one of: {[m.value for m in cls]}"
        )


@dataclasses.dataclass(frozen=True)
class PreferenceConfig:
    method: PreferenceMethod
    beta: float = 0.1
    label_smoothing: float = 0.0
    loss_type: Optional[str] = None
    extra: Mapping[str, Any] = dataclasses.field(default_factory=dict)

    @staticmethod
    def for_method(method: PreferenceMethod, **overrides: Any) -> "PreferenceConfig":
        defaults: dict[str, Any] = {
            PreferenceMethod.DPO: {"beta": 0.1, "loss_type": "sigmoid"},
            PreferenceMethod.KTO: {"beta": 0.1, "loss_type": "kto_pair"},
            PreferenceMethod.ORPO: {"beta": 0.1, "loss_type": "orpo"},
            PreferenceMethod.SIMPO: {
                "beta": 2.0,
                "loss_type": "simpo",
                "extra": {"gamma_beta_ratio": 0.5, "reference_free": True},
            },
            PreferenceMethod.IPO: {"beta": 0.1, "loss_type": "ipo"},
        }[method]
        d = dict(defaults)
        d.update(overrides)
        d["method"] = method
        return PreferenceConfig(**d)


def _import_trl():
    """Import trl lazily so that callers without trl can still import this module."""
    try:
        import trl  # noqa: F401
        return __import__("trl")
    except Exception as exc:  # pragma: no cover
        raise RuntimeError(
            "preference training needs `trl` installed. "
            "Run `pip install trl>=0.11.0`, then retry. "
            f"Underlying import error: {exc}"
        ) from exc


def _trainer_class(method: PreferenceMethod):
    """
    Return the trl trainer class for a given method.

    trl exposes DPOTrainer, KTOTrainer, ORPOTrainer, SimPOConfig, etc. with
    different shapes across versions. We probe forwards: if the dedicated
    class exists, use it; otherwise route through DPOTrainer + loss_type
    (trl >= 0.8 supports this for ipo/kto_pair).
    """
    trl = _import_trl()

    if method is PreferenceMethod.DPO:
        return getattr(trl, "DPOTrainer")

    if method is PreferenceMethod.KTO:
        cls = getattr(trl, "KTOTrainer", None)
        if cls is not None:
            return cls
        # Older trl: DPOTrainer with loss_type='kto_pair'
        return getattr(trl, "DPOTrainer")

    if method is PreferenceMethod.ORPO:
        cls = getattr(trl, "ORPOTrainer", None)
        if cls is None:
            raise RuntimeError(
                "ORPO requires trl>=0.8.6 with ORPOTrainer. "
                "Upgrade trl (`pip install -U trl`) or pick a different method."
            )
        return cls

    if method is PreferenceMethod.SIMPO:
        # SimPO is loss_type='simpo' on CPOTrainer in trl>=0.10
        cls = getattr(trl, "CPOTrainer", None)
        if cls is None:
            raise RuntimeError(
                "SimPO requires trl>=0.10 with CPOTrainer + loss_type='simpo'. "
                "Upgrade trl (`pip install -U trl`)."
            )
        return cls

    if method is PreferenceMethod.IPO:
        # IPO is loss_type='ipo' on DPOTrainer
        return getattr(trl, "DPOTrainer")

    raise ValueError(f"no trainer mapping for {method}")


def _build_config(method: PreferenceMethod, cfg: PreferenceConfig, *, base_args):
    """Build the trl Config object (DPOConfig / KTOConfig / ORPOConfig / CPOConfig)
    by copying training args from `base_args` (a transformers.TrainingArguments
    or similar) and folding in our loss-specific knobs.

    We use duck-typing here: trl ships many config classes; we just construct
    by name and ignore the rest.
    """
    trl = _import_trl()
    cls_name = {
        PreferenceMethod.DPO: "DPOConfig",
        PreferenceMethod.KTO: "KTOConfig",
        PreferenceMethod.ORPO: "ORPOConfig",
        PreferenceMethod.SIMPO: "CPOConfig",
        PreferenceMethod.IPO: "DPOConfig",
    }[method]
    cls = getattr(trl, cls_name, None)
    if cls is None:
        # Older trl: pass loss_type through to DPOTrainer kwargs directly
        return None

    # Copy whitelisted fields from base_args
    kw: dict[str, Any] = {}
    if base_args is not None:
        for field in (
            "output_dir",
            "num_train_epochs",
            "per_device_train_batch_size",
            "per_device_eval_batch_size",
            "gradient_accumulation_steps",
            "learning_rate",
            "lr_scheduler_type",
            "warmup_ratio",
            "weight_decay",
            "logging_steps",
            "save_steps",
            "save_total_limit",
            "evaluation_strategy",
            "bf16",
            "fp16",
            "gradient_checkpointing",
            "optim",
            "seed",
            "report_to",
            "remove_unused_columns",
        ):
            if hasattr(base_args, field):
                kw[field] = getattr(base_args, field)

    # Method-specific knobs
    kw["beta"] = cfg.beta
    if cfg.loss_type and cls_name in {"DPOConfig", "CPOConfig"}:
        kw["loss_type"] = cfg.loss_type
    if cfg.label_smoothing and cls_name == "DPOConfig":
        kw["label_smoothing"] = cfg.label_smoothing
    if cls_name == "CPOConfig" and "gamma_beta_ratio" in cfg.extra:
        kw["gamma_beta_ratio"] = cfg.extra["gamma_beta_ratio"]
    if cls_name == "CPOConfig" and cfg.extra.get("reference_free"):
        # SimPO mode
        kw["loss_type"] = "simpo"
    if cls_name == "ORPOConfig" and "lambda_" in cfg.extra:
        kw["lambda_"] = cfg.extra["lambda_"]

    return cls(**kw)


def preference_trainer(
    *,
    method: PreferenceMethod | str,
    model,
    tokenizer,
    train_dataset,
    eval_dataset=None,
    args=None,
    beta: Optional[float] = None,
    method_kwargs: Optional[Mapping[str, Any]] = None,
    ref_model=None,
):
    """
    Construct a preference trainer for the requested method.

    Args:
        method:        DPO/KTO/ORPO/SIMPO/IPO (string or PreferenceMethod)
        model:         the policy model (PEFT or full)
        tokenizer:     transformers tokenizer
        train_dataset: HF Dataset with shape per the method:
                       DPO/IPO/SIMPO: {"prompt", "chosen", "rejected"}
                       KTO:           {"prompt", "completion", "label"} where label is bool
                       ORPO:          {"prompt", "chosen", "rejected"}
        eval_dataset:  optional
        args:          transformers.TrainingArguments-like object copied into the trl config
        beta:          override the default beta for the method
        method_kwargs: extra kwargs folded into PreferenceConfig.extra
        ref_model:     reference model for DPO/IPO/KTO (None means trl re-uses model
                       with disabled adapters, which works for PEFT)

    Returns:
        a trl trainer with `.train()` and `.save_model(...)` ready to call.
    """
    if isinstance(method, str):
        method = PreferenceMethod.from_str(method)

    cfg = PreferenceConfig.for_method(method, **(method_kwargs or {}))
    if beta is not None:
        cfg = dataclasses.replace(cfg, beta=beta)

    TrainerCls = _trainer_class(method)
    trl_config = _build_config(method, cfg, base_args=args)

    common = {
        "model": model,
        "tokenizer": tokenizer,
        "train_dataset": train_dataset,
        "eval_dataset": eval_dataset,
    }

    # KTO does not take a ref_model in modern trl; it scores internally.
    # ORPO does not take a ref_model (single-stage).
    # SimPO is reference-free by construction.
    needs_ref = method in (PreferenceMethod.DPO, PreferenceMethod.IPO)
    if needs_ref:
        common["ref_model"] = ref_model

    if trl_config is not None:
        common["args"] = trl_config
    elif args is not None:
        common["args"] = args

    # Some older trl versions take loss_type as a top-level kwarg.
    if cfg.loss_type and trl_config is None:
        common["loss_type"] = cfg.loss_type

    logger.info(
        "[preference] method=%s beta=%.3f loss_type=%s ref_model=%s",
        method.value, cfg.beta, cfg.loss_type, "yes" if needs_ref else "no",
    )
    return TrainerCls(**common)


def recommend_method(*, num_pairs: int, has_sft_data: bool, vram_gb: float) -> PreferenceMethod:
    """
    A small router for the spec compiler. Picks a method given the user's
    captured data shape and the device VRAM budget.

    Rules of thumb baked in:
      - SFT data + preference data + tight VRAM -> ORPO (one pass, no ref model)
      - Only preference pairs + tight VRAM      -> SimPO (no ref model)
      - Plenty of VRAM, clean pairs              -> DPO  (battle-tested)
      - Binary good/bad labels                   -> KTO  (no pairs needed)
    """
    if vram_gb < 24 and has_sft_data:
        return PreferenceMethod.ORPO
    if vram_gb < 24:
        return PreferenceMethod.SIMPO
    if num_pairs < 200:
        return PreferenceMethod.KTO   # KTO works with smaller, noisier labels
    return PreferenceMethod.DPO


__all__ = [
    "PreferenceMethod",
    "PreferenceConfig",
    "preference_trainer",
    "recommend_method",
]
