"""
apps/trainer/dapo_sampling.py

DAPO dynamic sampling -- the one frontier RLVR mechanism trl 0.24 does NOT own.

GRPO computes a per-completion advantage A_i = (r_i - mean(r)) / sd(r) over the
G completions sampled for one prompt (the "group"). A group whose G rewards are
ALL EQUAL (every completion passed, r=1, or every completion failed, r=0) has
sd(r) == 0 -> every A_i collapses to 0 -> zero gradient -> wasted forward/backward
compute AND a batch biased toward already-solved / hopeless prompts.

DAPO (Yu et al 2025, arXiv:2503.14476, sec 3.2 "Dynamic Sampling") drops those
zero-variance groups and OVERSAMPLES new prompts to refill the effective batch to
a target group count, capped by a resample budget. This is a DATASET / sampling-
loop concern that sits ABOVE trl's per-step inner loop, so kolm must own it.

We implement it as a PREFILTER + over-provision pass over the prompts dataset
using the SAME deterministic reward functions that score the K-score gate
(train-eval identity preserved). It records drop counts in receipt-grade stats so
the signed .kolm artifact can prove the mechanism ENGAGED, not aspired.

Privacy / moat: scoring is LOCAL ONLY. The reward fn is the kolm verifier code
path -- no prompt or completion text leaves the box, no external judge, no
hyperscaler call. The stats below contain ONLY counts and config, never raw data.

Caveats:
  * Pure Python. NO torch / vllm / trl import at module top. The real-GPU rollout
    function (which DOES import torch / vllm) is supplied by the caller; in
    preflight / no-GPU tests a stub rollout fn proves the math GPU-free.
  * sd is the population standard deviation over the G rewards of one group.
    "all-equal" is detected by sd == 0 within a tolerance, which is exactly the
    zero-advantage condition GRPO would hit.

Citations:
  DAPO:    Yu et al, 2025, arXiv:2503.14476 (Dynamic Sampling, Clip-Higher)
  GRPO:    Shao et al, 2024, arXiv:2402.03300 (DeepSeek-MATH)
"""

from __future__ import annotations

import dataclasses
import math
import random
from typing import Any, Callable, Mapping, Optional, Sequence

# A rollout fn takes a prompt row + the group size G and returns G completion
# strings. In preflight/tests it is a deterministic stub; on a real GPU it wraps
# the model.generate / vLLM path (which is where torch is imported, NOT here).
RolloutFn = Callable[[Mapping[str, Any], int], Sequence[str]]

# A reward fn takes (prompt, completions, row) and returns one float per
# completion -- the SAME shape and code path as the GRPO reward functions in
# apps.trainer.grpo. Local, deterministic, no network.
RewardFn = Callable[[str, Sequence[str], Mapping[str, Any]], Sequence[float]]

_SD_TOL = 1e-12


def _population_sd(values: Sequence[float]) -> float:
    """Population standard deviation. Returns 0.0 for <2 values or all-equal."""
    n = len(values)
    if n < 2:
        return 0.0
    mean = sum(values) / n
    var = sum((v - mean) ** 2 for v in values) / n
    if var <= 0.0:
        return 0.0
    return math.sqrt(var)


def _prompt_of(row: Mapping[str, Any]) -> Optional[str]:
    if not isinstance(row, Mapping):
        return None
    for key in ("prompt", "input", "question"):
        v = row.get(key)
        if v is not None:
            return str(v)
    return None


def dynamic_sample(
    rows: Sequence[Mapping[str, Any]],
    reward_fn: RewardFn,
    rollout_fn: RolloutFn,
    *,
    num_generations: int = 8,
    target_groups: int,
    max_resample_factor: int = 3,
    seed: int = 42,
) -> "tuple[list[Mapping[str, Any]], dict[str, Any]]":
    """
    DAPO dynamic-sampling prefilter.

    For each candidate prompt (in a deterministic shuffled order seeded by `seed`):
      1. roll out G = num_generations completions via rollout_fn,
      2. score them with reward_fn (the LOCAL kolm verifier code path),
      3. compute the population sd of the G rewards,
      4. DROP the group if sd == 0 (all-pass or all-fail -> zero advantage),
         else KEEP it.

    Refill from remaining prompts until `target_groups` kept OR the resample
    budget (max_resample_factor * target_groups candidate prompts) is exhausted.

    Returns (kept_rows, stats). Deterministic for a fixed seed + inputs.

    stats keys (receipt-grade evidence the mechanism engaged):
      candidates_seen, groups_kept, groups_dropped_all_pass,
      groups_dropped_all_fail, groups_dropped_other, resample_factor_used,
      target_groups, num_generations, budget_exhausted, max_resample_factor.

    Args:
      rows:            prompt rows ({prompt, tests|references|schemas|...}).
      reward_fn:       (prompt, completions, row) -> [float] per completion.
      rollout_fn:      (row, G) -> G completion strings. torch/vllm live HERE,
                       not at module top, so this module stays GPU-free.
      num_generations: G, the group size (>= 2; sd of <2 is undefined -> always 0).
      target_groups:   how many KEPT (non-degenerate) groups to assemble.
      max_resample_factor: budget cap; at most this many * target_groups prompts
                       are rolled out before giving up.
      seed:            RNG seed for the deterministic candidate order.
    """
    if target_groups is None or target_groups < 1:
        raise ValueError("dynamic_sample: target_groups must be a positive int")
    if num_generations < 2:
        raise ValueError(
            "dynamic_sample: num_generations must be >= 2 (sd of a single "
            "completion is undefined; GRPO needs a group)"
        )
    if max_resample_factor < 1:
        raise ValueError("dynamic_sample: max_resample_factor must be >= 1")

    pool = [r for r in rows if _prompt_of(r) is not None]
    rng = random.Random(seed)
    order = list(range(len(pool)))
    rng.shuffle(order)

    budget = max_resample_factor * target_groups

    kept: "list[Mapping[str, Any]]" = []
    candidates_seen = 0
    dropped_all_pass = 0
    dropped_all_fail = 0
    dropped_other = 0

    for idx in order:
        if len(kept) >= target_groups:
            break
        if candidates_seen >= budget:
            break
        row = pool[idx]
        prompt = _prompt_of(row)
        completions = list(rollout_fn(row, num_generations))
        if len(completions) != num_generations:
            raise ValueError(
                f"dynamic_sample: rollout_fn returned {len(completions)} "
                f"completions, expected num_generations={num_generations}"
            )
        rewards = list(reward_fn(prompt, completions, row))
        if len(rewards) != num_generations:
            raise ValueError(
                f"dynamic_sample: reward_fn returned {len(rewards)} rewards, "
                f"expected num_generations={num_generations}"
            )
        candidates_seen += 1

        sd = _population_sd(rewards)
        if sd <= _SD_TOL:
            # Zero-variance group -> zero advantage -> drop. Attribute the drop.
            mean = sum(rewards) / len(rewards) if rewards else 0.0
            if mean >= 1.0 - _SD_TOL:
                dropped_all_pass += 1
            elif mean <= _SD_TOL:
                dropped_all_fail += 1
            else:
                # All-equal at an intermediate value (e.g. every completion got
                # partial credit 0.5). Still zero-advantage, still dropped, but
                # it is neither all-pass nor all-fail.
                dropped_other += 1
            continue
        kept.append(row)

    budget_exhausted = (len(kept) < target_groups)
    resample_factor_used = (
        (candidates_seen / target_groups) if target_groups else 0.0
    )

    stats = {
        "mechanism": "dapo_dynamic_sampling",
        "paper": "arXiv:2503.14476",
        "candidates_seen": candidates_seen,
        "groups_kept": len(kept),
        "groups_dropped_all_pass": dropped_all_pass,
        "groups_dropped_all_fail": dropped_all_fail,
        "groups_dropped_other": dropped_other,
        "target_groups": int(target_groups),
        "num_generations": int(num_generations),
        "max_resample_factor": int(max_resample_factor),
        "resample_factor_used": round(resample_factor_used, 6),
        "budget_exhausted": bool(budget_exhausted),
        "seed": int(seed),
    }
    return kept, stats


# --------------------------------------------------------------------------- #
# Engaged-knobs reflector (kolm-owned until merge into apps/trainer/grpo.py).
#
# This closes the PROVENANCE hole: it reads back the attributes ACTUALLY set on
# a constructed trl.GRPOConfig and reports applied=true/false per knob, so the
# signed receipt describes the REAL run -- never what kolm merely requested.
# --------------------------------------------------------------------------- #

# The frontier knobs whose engagement the receipt must verify by read-back.
FRONTIER_KNOBS = (
    "loss_type",
    "scale_rewards",
    "importance_sampling_level",
    "epsilon_high",
    "mask_truncated_completions",
    "use_vllm",
    "vllm_mode",
)

# Closed enums (mirror src/distill-grpo-frontier.js + trl 0.24 acceptance).
LOSS_TYPES = ("grpo", "bnpo", "dr_grpo", "dapo")
IS_LEVELS = ("token", "sequence")
SCALE_REWARDS = ("group", "batch", "none")


def normalize_scale_rewards(value: Any, *, trl_module: Any = None) -> Any:
    """
    Normalize scale_rewards to the installed trl's accepted type.

    trl 0.24 accepts BOTH the string enum {'group','batch','none'} and a bool
    (True -> 'group', False -> 'none'). Older trl may accept only one. We probe
    the constructed config's coercion: if the installed trl rejects a bool we
    translate True->'group', False->'none'; otherwise we pass the value through
    and let trl coerce it (read-back will report the actual stored value).
    """
    if isinstance(value, str):
        if value not in SCALE_REWARDS:
            raise ValueError(
                f"scale_rewards string must be one of {SCALE_REWARDS}; got {value!r}"
            )
        return value
    if not isinstance(value, bool):
        raise ValueError(
            f"scale_rewards must be a bool or one of {SCALE_REWARDS}; got {value!r}"
        )
    # value is a bool. Decide whether the installed trl tolerates it.
    if trl_module is None:
        try:
            import trl as trl_module  # type: ignore
        except Exception:
            trl_module = None
    if trl_module is not None:
        GRPOConfig = getattr(trl_module, "GRPOConfig", None)
        if GRPOConfig is not None:
            try:
                GRPOConfig(scale_rewards=value)
                return value  # bool tolerated -> pass through
            except Exception:
                pass  # bool rejected -> translate below
    return "group" if value else "none"


def reflect_engaged(
    requested: Mapping[str, Any],
    trl_config: Any,
    *,
    trl_module: Any = None,
) -> dict[str, Any]:
    """
    Build the `engaged` map by READING BACK the attributes actually set on the
    constructed trl.GRPOConfig.

    For each frontier knob in `requested`:
      * applied=True  + accepted=<read-back value> when the constructed config
        carries the attribute (knob reached trl),
      * applied=False + reason='trl_signature_missing' when the installed trl
        signature lacked the kwarg (knob was silently dropped on the floor).

    The receipt reports THIS map, never the raw request. A knob is never claimed
    engaged unless it was read back off the real config object.
    """
    accepted_params = None
    try:
        import inspect
        if trl_module is None:
            import trl as trl_module  # type: ignore
        GRPOConfig = getattr(trl_module, "GRPOConfig", None)
        if GRPOConfig is not None:
            sig = inspect.signature(GRPOConfig.__init__)
            accepted_params = set(sig.parameters.keys())
    except Exception:
        accepted_params = None

    engaged: dict[str, Any] = {}
    for knob, want in requested.items():
        if knob not in FRONTIER_KNOBS:
            continue
        signature_has = (accepted_params is None) or (knob in accepted_params)
        config_has = hasattr(trl_config, knob)
        if signature_has and config_has:
            engaged[knob] = {
                "requested": want,
                "accepted": getattr(trl_config, knob),
                "applied": True,
                "reason": "read_back_from_trl_config",
            }
        else:
            engaged[knob] = {
                "requested": want,
                "accepted": None,
                "applied": False,
                "reason": "trl_signature_missing",
            }
    return engaged


def frontier_receipt(
    requested: Mapping[str, Any],
    trl_config: Any,
    *,
    dynamic_sampling_stats: Optional[Mapping[str, Any]] = None,
    trl_module: Any = None,
) -> dict[str, Any]:
    """
    Assemble the additive `frontier` + `engaged` receipt blocks from the REAL
    constructed trl config. Stable, additive, count-only (privacy-safe).
    """
    engaged = reflect_engaged(requested, trl_config, trl_module=trl_module)

    def _eng(knob: str) -> Any:
        e = engaged.get(knob)
        return e["accepted"] if (e and e["applied"]) else None

    use_vllm = bool(_eng("use_vllm"))
    frontier = {
        "loss_type_engaged": _eng("loss_type"),
        "scale_rewards_engaged": _eng("scale_rewards"),
        "importance_sampling_level_engaged": _eng("importance_sampling_level"),
        "epsilon_high_engaged": _eng("epsilon_high"),
        "mask_truncated_completions_engaged": _eng("mask_truncated_completions"),
        "rollout_engine": "vllm" if use_vllm else "hf",
        "dynamic_sampling": dict(dynamic_sampling_stats)
        if dynamic_sampling_stats is not None
        else None,
    }
    return {
        "frontier": frontier,
        "engaged": engaged,
        "papers": ["arXiv:2503.14476", "arXiv:2507.18071", "arXiv:2503.20783"],
    }


# --------------------------------------------------------------------------- #
# Corrected GRPO config (kolm-owned until merge into apps/trainer/grpo.py).
#
# The legacy apps/trainer/grpo.py GRPOTrainConfig EXCLUDES loss_type and
# importance_sampling_level from as_trl_kwargs() (the _NON_TRL frozenset), so
# GSPO + DAPO loss were NEVER forwarded to trl -- trl silently used its OWN
# defaults while the receipt reported what kolm WANTED. That is the provenance
# falsehood. This corrected config FORWARDS them (no _NON_TRL exclusion), adds
# 'dapo' to the accepted enum, normalizes scale_rewards to the installed trl's
# accepted type, and is the merge target for apps/trainer/grpo.py.
# --------------------------------------------------------------------------- #


@dataclasses.dataclass(frozen=True)
class FrontierGRPOConfig:
    """trl.GRPOConfig kwargs WITH the frontier knobs actually forwarded.

    Same field surface as apps.trainer.grpo.GRPOTrainConfig, but as_trl_kwargs()
    DOES forward loss_type + importance_sampling_level (the falsehood is closed),
    accepts loss_type='dapo', and normalizes scale_rewards. The receipt is built
    by reading the constructed trl config back via reflect_engaged/frontier_receipt
    -- never from this requested config.
    """

    num_generations: int = 8
    max_completion_length: int = 512
    max_prompt_length: int = 512
    temperature: float = 0.7
    top_p: float = 0.95
    learning_rate: float = 5e-6
    beta: float = 0.04
    epsilon: float = 0.2
    num_train_epochs: int = 1
    per_device_train_batch_size: int = 1
    gradient_accumulation_steps: int = 8
    logging_steps: int = 10
    save_steps: int = 100
    output_dir: str = "./out/grpo"
    seed: int = 42
    bf16: bool = True

    # Frontier knobs -- FORWARDED (no _NON_TRL exclusion). loss_type default is
    # 'dapo' to MATCH trl 0.24's own default (the legacy 'grpo' default silently
    # disagreed with trl). epsilon_high default 0.0 == "use symmetric epsilon".
    loss_type: str = "dapo"
    scale_rewards: Any = "group"  # 'group'|'batch'|'none' or bool
    epsilon_high: float = 0.0
    importance_sampling_level: str = "token"
    mask_truncated_completions: bool = False
    use_vllm: bool = False
    vllm_mode: str = "colocate"

    def as_trl_kwargs(self, *, trl_module: Any = None) -> dict[str, Any]:
        """Return trl.GRPOConfig kwargs. Forwards EVERY frontier knob (loss_type
        + importance_sampling_level included), filtered ONLY to the fields the
        INSTALLED trl.GRPOConfig accepts (a version mismatch never raises; the
        dropped knob shows up as applied=false in reflect_engaged, never silently
        claimed engaged). scale_rewards is normalized to the installed trl's
        accepted type."""
        if self.loss_type not in LOSS_TYPES:
            raise ValueError(f"loss_type must be one of {LOSS_TYPES}; got {self.loss_type!r}")
        if self.importance_sampling_level not in IS_LEVELS:
            raise ValueError(
                f"importance_sampling_level must be one of {IS_LEVELS}; "
                f"got {self.importance_sampling_level!r}"
            )

        raw = dataclasses.asdict(self)
        raw["scale_rewards"] = normalize_scale_rewards(
            self.scale_rewards, trl_module=trl_module
        )

        accepted = None
        try:
            import inspect
            if trl_module is None:
                import trl as trl_module  # type: ignore
            GRPOConfig = getattr(trl_module, "GRPOConfig", None)
            if GRPOConfig is not None:
                sig = inspect.signature(GRPOConfig.__init__)
                accepted = set(sig.parameters.keys())
        except Exception:
            accepted = None

        out: dict[str, Any] = {}
        for k, v in raw.items():
            if k.startswith("_"):
                continue
            # epsilon_high 0.0 means "symmetric, use epsilon" -> only forward when set.
            if k == "epsilon_high" and (v is None or v == 0.0):
                continue
            if accepted is None or k in accepted:
                out[k] = v
        return out

    def requested_frontier(self) -> dict[str, Any]:
        """The requested frontier knobs (for reflect_engaged -> engaged map)."""
        req = {
            "loss_type": self.loss_type,
            "scale_rewards": normalize_scale_rewards(self.scale_rewards),
            "importance_sampling_level": self.importance_sampling_level,
            "mask_truncated_completions": self.mask_truncated_completions,
            "use_vllm": self.use_vllm,
            "vllm_mode": self.vllm_mode,
        }
        if not (self.epsilon_high is None or self.epsilon_high == 0.0):
            req["epsilon_high"] = self.epsilon_high
        return req


def preflight_engaged_map(cfg: "FrontierGRPOConfig") -> dict[str, Any]:
    """
    GPU-free preflight: construct the REAL trl.GRPOConfig (when trl is installed)
    from cfg.as_trl_kwargs(), read back the engaged knobs, and return the receipt
    frontier+engaged map. When trl is ABSENT, return the same-shaped map with
    every knob applied=false reason='trl_not_installed' plus a durable install
    hint -- so the receipt contract is testable without trl/torch/GPU.

    This is the kolm-owned merge target for train_grpo.py --preflight-only (which
    currently emits only a flat preflight dict, not the engaged map).
    """
    requested = cfg.requested_frontier()
    try:
        import trl  # type: ignore
        trl_version = getattr(trl, "__version__", "unknown")
        trl_cfg = trl.GRPOConfig(**cfg.as_trl_kwargs(trl_module=trl))
        rb = frontier_receipt(requested, trl_cfg, trl_module=trl)
        rb["trl_version"] = trl_version
        rb["preflight"] = "ok"
        rb["trl_installed"] = True
        return rb
    except ImportError:
        engaged = {
            k: {
                "requested": v,
                "accepted": None,
                "applied": False,
                "reason": "trl_not_installed",
            }
            for k, v in requested.items()
            if k in FRONTIER_KNOBS
        }
        return {
            "preflight": "ok",
            "trl_installed": False,
            "engaged": engaged,
            "frontier": None,
            "papers": ["arXiv:2503.14476", "arXiv:2507.18071", "arXiv:2503.20783"],
            "install_hint": "pip install 'trl>=0.12.0' torch transformers peft",
        }


def _main(argv=None) -> int:
    """`python -m apps.trainer.dapo_sampling --preflight ...` -> engaged-map JSON,
    GPU-free. Proves the receipt contract without trl/torch/GPU."""
    import argparse
    import json

    p = argparse.ArgumentParser(description="DAPO/GSPO frontier preflight (GPU-free)")
    p.add_argument("--preflight", action="store_true", default=True)
    p.add_argument("--loss-type", default="dapo", choices=list(LOSS_TYPES))
    p.add_argument("--importance-sampling-level", default="token", choices=list(IS_LEVELS))
    p.add_argument("--scale-rewards", default="group")
    p.add_argument("--epsilon-high", type=float, default=0.0)
    p.add_argument("--mask-truncated-completions", action="store_true")
    p.add_argument("--use-vllm", action="store_true")
    p.add_argument("--vllm-mode", default="colocate")
    args = p.parse_args(argv)

    sr: Any = args.scale_rewards
    if sr == "true":
        sr = True
    elif sr == "false":
        sr = False

    cfg = FrontierGRPOConfig(
        loss_type=args.loss_type,
        importance_sampling_level=args.importance_sampling_level,
        scale_rewards=sr,
        epsilon_high=args.epsilon_high,
        mask_truncated_completions=args.mask_truncated_completions,
        use_vllm=args.use_vllm,
        vllm_mode=args.vllm_mode,
    )
    print(json.dumps({"ok": True, **preflight_engaged_map(cfg)}))
    return 0


__all__ = [
    "dynamic_sample",
    "reflect_engaged",
    "frontier_receipt",
    "preflight_engaged_map",
    "normalize_scale_rewards",
    "FrontierGRPOConfig",
    "FRONTIER_KNOBS",
    "LOSS_TYPES",
    "IS_LEVELS",
    "SCALE_REWARDS",
]


if __name__ == "__main__":
    import sys as _sys
    _sys.exit(_main())
