"""
apps/trainer/grpo.py

GRPO with verifiable rewards. The reasoning-RL algorithm behind DeepSeek R1.

GRPO (Group Relative Policy Optimization) was introduced in Shao et al 2024
(arXiv:2402.03300, DeepSeek-MATH) and made famous by DeepSeek R1 (arXiv:2501.12948).
The advantage over PPO is mechanical: no value head, no separate critic to train.
You sample G completions per prompt, score each with a reward function, and the
advantage is the per-completion score minus the group mean over the group std.

For kolm, the value is that the reward function is the same code path as the
K-score evaluator. The reward function and the release gate score the same
output the same way. Train-eval mismatch becomes a hard error, not a culture.

Reward families shipped here:

    code_exec       sandboxed subprocess + unit tests
    math_checker    numeric / symbolic equivalence
    schema_validator JSON-schema or regex match

A buyer can register their own. Reward functions take (prompts, completions)
and return a list of float rewards (one per completion), trl's standard shape.

Surface:

    from apps.trainer.grpo import grpo_trainer, GRPOConfig, REWARD_FUNCTIONS

    trainer = grpo_trainer(
        model=peft_model,
        tokenizer=tokenizer,
        train_dataset=prompts_dataset,
        reward_funcs=[REWARD_FUNCTIONS['code_exec']],
        args=GRPOConfig(
            num_generations=8,
            max_completion_length=512,
            temperature=0.7,
            learning_rate=5e-6,
        ),
    )
    trainer.train()

Citations:
  GRPO:          Shao et al, 2024, arXiv:2402.03300 (DeepSeek-MATH)
  DeepSeek R1:   DeepSeek-AI, 2025, arXiv:2501.12948
  trl GRPOTrainer: huggingface/trl >= 0.12.0
"""

from __future__ import annotations

import dataclasses
import json
import logging
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)

RewardFunc = Callable[[Sequence[str], Sequence[str], Mapping[str, Any]], list[float]]


@dataclasses.dataclass(frozen=True)
class GRPOTrainConfig:
    """
    Args we pass into trl.GRPOConfig. Kept as our own dataclass so the receipt
    block stays stable across trl version bumps.
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

    def as_trl_kwargs(self) -> dict[str, Any]:
        return dataclasses.asdict(self)


def _import_trl():
    try:
        import trl
        return trl
    except Exception as exc:
        raise RuntimeError(
            "GRPO training needs `trl` installed. "
            "Run `pip install 'trl>=0.12.0'`, then retry. "
            f"Underlying import error: {exc}"
        ) from exc


def _grpo_classes():
    """Resolve trl.GRPOTrainer and trl.GRPOConfig with a crisp error if too old."""
    trl = _import_trl()
    GRPOTrainer = getattr(trl, "GRPOTrainer", None)
    GRPOConfig = getattr(trl, "GRPOConfig", None)
    if GRPOTrainer is None or GRPOConfig is None:
        ver = getattr(trl, "__version__", "unknown")
        raise RuntimeError(
            f"GRPO training requires trl >= 0.12.0 with GRPOTrainer + GRPOConfig. "
            f"Installed trl version: {ver}. "
            f"Upgrade: `pip install -U 'trl>=0.12.0'`."
        )
    return GRPOTrainer, GRPOConfig


def _extract_answer(text: str) -> Optional[str]:
    """
    Pull the final answer from a reasoning trace. Looks for, in order:
      <answer>...</answer>     R1-style answer tag
      \\boxed{...}             math convention
      'Answer:' prefix         common english pattern
    """
    if not isinstance(text, str):
        return None
    m = re.search(r"<answer>(.*?)</answer>", text, re.DOTALL | re.IGNORECASE)
    if m:
        return m.group(1).strip()
    m = re.search(r"\\boxed\{([^{}]+)\}", text)
    if m:
        return m.group(1).strip()
    m = re.search(r"(?:final\s+)?answer\s*[:=]\s*(.+?)(?:\n|$)", text, re.IGNORECASE)
    if m:
        return m.group(1).strip().rstrip(".")
    return None


def _normalize_number(s: str) -> Optional[float]:
    if s is None:
        return None
    s = s.strip().replace(",", "").replace("$", "").replace("%", "")
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def reward_math_checker(
    prompts: Sequence[str],
    completions: Sequence[str],
    references: Sequence[Any],
    *,
    tolerance: float = 1e-4,
) -> list[float]:
    """
    Reward 1.0 if the extracted answer is numerically (or string-) equivalent
    to the reference, 0.0 otherwise.

    `references` is a per-prompt list of gold answers (number or string).
    Mismatched lengths raise; we don't silently misalign rewards.
    """
    if len(completions) != len(references):
        raise ValueError(
            f"reward_math_checker: {len(completions)} completions vs "
            f"{len(references)} references."
        )
    rewards: list[float] = []
    for c, ref in zip(completions, references):
        ans = _extract_answer(c)
        if ans is None:
            rewards.append(0.0)
            continue
        a_num = _normalize_number(ans)
        r_num = _normalize_number(str(ref)) if not isinstance(ref, (int, float)) else float(ref)
        if a_num is not None and r_num is not None:
            rewards.append(1.0 if abs(a_num - r_num) <= tolerance else 0.0)
        else:
            rewards.append(1.0 if str(ans).strip().lower() == str(ref).strip().lower() else 0.0)
    return rewards


def reward_schema_validator(
    prompts: Sequence[str],
    completions: Sequence[str],
    schemas: Sequence[Mapping[str, Any]] | None = None,
    regexes: Sequence[str] | None = None,
) -> list[float]:
    """
    Reward 1.0 if the completion parses as JSON and validates against the
    per-prompt schema, or matches the per-prompt regex. 0.0 otherwise.

    Exactly one of `schemas` or `regexes` must be provided.
    """
    if (schemas is None) == (regexes is None):
        raise ValueError(
            "reward_schema_validator: provide exactly one of schemas= or regexes=."
        )

    if regexes is not None:
        if len(regexes) != len(completions):
            raise ValueError(
                f"reward_schema_validator: {len(completions)} completions vs "
                f"{len(regexes)} regexes."
            )
        out: list[float] = []
        for c, pat in zip(completions, regexes):
            try:
                out.append(1.0 if re.search(pat, c) else 0.0)
            except re.error:
                out.append(0.0)
        return out

    try:
        import jsonschema  # type: ignore
    except Exception as exc:
        raise RuntimeError(
            "reward_schema_validator with `schemas=` needs `jsonschema`. "
            "Install with `pip install jsonschema`. "
            f"Import error: {exc}"
        ) from exc

    if len(schemas) != len(completions):
        raise ValueError(
            f"reward_schema_validator: {len(completions)} completions vs "
            f"{len(schemas)} schemas."
        )
    out: list[float] = []
    for c, sch in zip(completions, schemas):
        ans = _extract_answer(c) or c
        try:
            obj = json.loads(ans)
        except (TypeError, ValueError):
            out.append(0.0)
            continue
        try:
            jsonschema.validate(obj, sch)
            out.append(1.0)
        except jsonschema.ValidationError:
            out.append(0.0)
        except Exception:
            out.append(0.0)
    return out


def _run_python(code: str, timeout: float) -> tuple[int, str, str]:
    """
    Execute `code` in a subprocess with a temp working dir and timeout. Returns
    (returncode, stdout, stderr). Captures both streams without inheriting env
    secrets.
    """
    with tempfile.TemporaryDirectory(prefix="kolm-grpo-") as tmp:
        src = Path(tmp) / "candidate.py"
        src.write_text(code, encoding="utf-8")
        try:
            r = subprocess.run(
                ["python", "-I", str(src)],
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=tmp,
                env={"PYTHONIOENCODING": "utf-8", "PYTHONHASHSEED": "0"},
            )
            return r.returncode, r.stdout or "", r.stderr or ""
        except subprocess.TimeoutExpired:
            return 124, "", "timeout"
        except Exception as exc:
            return 1, "", f"runner-error: {exc}"


def reward_code_exec(
    prompts: Sequence[str],
    completions: Sequence[str],
    tests: Sequence[Sequence[str]],
    *,
    timeout: float = 8.0,
    pass_weight: float = 1.0,
) -> list[float]:
    """
    Execute each completion as Python in a sandbox, then run each test snippet.
    Reward is pass_weight * (passed / total).

    `tests` is a per-prompt list of test strings; each test gets appended to
    the candidate code and the combined script must exit 0.
    """
    if len(completions) != len(tests):
        raise ValueError(
            f"reward_code_exec: {len(completions)} completions vs "
            f"{len(tests)} test packs."
        )
    out: list[float] = []
    for c, suite in zip(completions, tests):
        code = _extract_code(c) or c
        if not suite:
            out.append(0.0)
            continue
        passed = 0
        for test in suite:
            combined = code + "\n\n# --- test ---\n" + test + "\n"
            rc, _so, _se = _run_python(combined, timeout)
            if rc == 0:
                passed += 1
        out.append(pass_weight * (passed / max(len(suite), 1)))
    return out


def _extract_code(text: str) -> Optional[str]:
    """Pull Python from a ```python ... ``` block, or return None."""
    if not isinstance(text, str):
        return None
    m = re.search(r"```(?:python|py)?\s*\n(.*?)```", text, re.DOTALL)
    if m:
        return m.group(1).strip()
    return None


REWARD_FUNCTIONS: dict[str, Callable[..., list[float]]] = {
    "code_exec": reward_code_exec,
    "math_checker": reward_math_checker,
    "schema_validator": reward_schema_validator,
}


def make_format_reward(open_tag: str = "<think>", close_tag: str = "</think>") -> RewardFunc:
    """
    A simple structural reward: completion contains a non-empty <think>...</think>
    block before the answer. Useful as an auxiliary alongside a correctness reward
    to keep the chain-of-thought structure intact during early training.
    """
    pat = re.compile(re.escape(open_tag) + r"(.+?)" + re.escape(close_tag), re.DOTALL)

    def _reward(prompts: Sequence[str], completions: Sequence[str], **_: Any) -> list[float]:
        out: list[float] = []
        for c in completions:
            m = pat.search(c or "")
            out.append(1.0 if (m and m.group(1).strip()) else 0.0)
        return out

    return _reward


def grpo_trainer(
    *,
    model,
    tokenizer,
    train_dataset,
    reward_funcs: Sequence[RewardFunc],
    args: Optional[GRPOTrainConfig] = None,
    eval_dataset=None,
):
    """
    Build a trl.GRPOTrainer with our config defaults. Returns the trainer; the
    caller invokes `.train()`.

    `reward_funcs` is a list of functions with trl's signature
    `f(prompts, completions, **kwargs) -> list[float]`. Multiple reward
    functions get averaged inside trl.
    """
    if not reward_funcs:
        raise ValueError("grpo_trainer needs at least one reward function.")

    cfg = args or GRPOTrainConfig()
    GRPOTrainer, GRPOConfig = _grpo_classes()

    trl_cfg = GRPOConfig(**cfg.as_trl_kwargs())

    logger.info(
        "grpo: G=%d, max_completion=%d, temp=%.2f, lr=%g, beta=%.3f, seed=%d",
        cfg.num_generations,
        cfg.max_completion_length,
        cfg.temperature,
        cfg.learning_rate,
        cfg.beta,
        cfg.seed,
    )

    return GRPOTrainer(
        model=model,
        processing_class=tokenizer,
        reward_funcs=list(reward_funcs),
        args=trl_cfg,
        train_dataset=train_dataset,
        eval_dataset=eval_dataset,
    )


def receipt_block(
    cfg: GRPOTrainConfig,
    *,
    reward_names: Iterable[str],
    train_examples: int,
    final_loss: Optional[float] = None,
    final_reward_mean: Optional[float] = None,
) -> dict[str, Any]:
    """
    Return the dict that gets folded into the artifact's receipt as
    `train.method='grpo'`. Kept stable across trl version bumps so verifiers
    don't need to track trl internals.
    """
    try:
        import trl
        trl_version = getattr(trl, "__version__", "unknown")
    except Exception:
        trl_version = "not-installed"
    return {
        "method": "grpo",
        "trl_version": trl_version,
        "papers": ["arXiv:2402.03300", "arXiv:2501.12948"],
        "num_generations": cfg.num_generations,
        "max_completion_length": cfg.max_completion_length,
        "max_prompt_length": cfg.max_prompt_length,
        "temperature": cfg.temperature,
        "top_p": cfg.top_p,
        "learning_rate": cfg.learning_rate,
        "beta": cfg.beta,
        "epsilon": cfg.epsilon,
        "num_train_epochs": cfg.num_train_epochs,
        "seed": cfg.seed,
        "reward_funcs": sorted(set(reward_names)),
        "train_examples": int(train_examples),
        "final_loss": float(final_loss) if final_loss is not None else None,
        "final_reward_mean": float(final_reward_mean) if final_reward_mean is not None else None,
    }


__all__ = [
    "GRPOTrainConfig",
    "REWARD_FUNCTIONS",
    "grpo_trainer",
    "make_format_reward",
    "receipt_block",
    "reward_code_exec",
    "reward_math_checker",
    "reward_schema_validator",
]
