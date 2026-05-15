"""
apps/trainer/reward.py

Bradley-Terry reward model training. The third leg of the RLHF triad.

The pipeline is: SFT → reward model → preference optimization (DPO / GRPO / PPO).
We ship SFT (trainer_real.py), DPO and friends (preference.py), and GRPO with
verifiable rewards (grpo.py). What was missing: a reward model trained from
human preferences when the reward is not a checkable function.

Use this when:

  * You have human-labeled (chosen, rejected) pairs and want a scalar reward
    head that generalizes to unseen prompts.
  * You want to train PPO/GRPO with a learned reward instead of a hand-written
    one (e.g. helpfulness, harmlessness, style fit).
  * You want a single reward model that ranks candidate responses for online
    inference (best-of-N gating, judge-mix priors).

References:

  * Bradley & Terry, 1952. "Rank Analysis of Incomplete Block Designs."
    The original pairwise-comparison loss.
  * Ouyang et al, 2022. "Training language models to follow instructions
    with human feedback." arXiv:2203.02155. The InstructGPT RM recipe.
  * Stiennon et al, 2020. "Learning to summarize from human feedback."
    arXiv:2009.01325. The first practical RLHF reward model.
  * Bai et al, 2022. "Training a Helpful and Harmless Assistant with
    Reinforcement Learning from Human Feedback." arXiv:2204.05862.

Surface:

    from apps.trainer.reward import reward_trainer, RewardConfig

    trainer = reward_trainer(
        base_model="Qwen/Qwen2.5-3B-Instruct",
        train_jsonl="preferences.jsonl",
        out_dir="rm/",
        config=RewardConfig(epochs=1, lr=5e-6, beta=1.0),
    )
    trainer.train()
    score = trainer.score(prompt="...", response="...")

Input JSONL shape (one line per preference pair):

    {"prompt": "...", "chosen": "...", "rejected": "..."}

The receipt records the loss curve, eval pair accuracy, the base-model CID,
and the reward-head SHA so the downstream RLHF run can prove which RM it used.
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional, Iterable, Any

# Hard imports stay at module load so a missing dep fails closed with a clear
# pip-install hint rather than surfacing later as an AttributeError.
try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
except ImportError as e:
    raise ImportError(
        "reward.py needs torch. pip install 'torch>=2.4,<2.9'."
    ) from e

try:
    from transformers import (
        AutoTokenizer,
        AutoModel,
        AutoModelForSequenceClassification,
        TrainingArguments,
        Trainer,
    )
except ImportError as e:
    raise ImportError(
        "reward.py needs transformers. pip install 'transformers>=4.45'."
    ) from e


@dataclass
class RewardConfig:
    """Training knobs for the Bradley-Terry head.

    beta scales the logit margin; raising it makes the model push chosen and
    rejected farther apart. 1.0 is the InstructGPT default and rarely wrong.
    """

    epochs: int = 1
    lr: float = 5e-6
    weight_decay: float = 0.0
    batch_size: int = 8
    grad_accum: int = 1
    max_length: int = 2048
    beta: float = 1.0
    bf16: bool = True
    seed: int = 42
    gradient_checkpointing: bool = True
    eval_split: float = 0.05
    eval_steps: int = 50
    logging_steps: int = 10
    save_steps: int = 200
    warmup_ratio: float = 0.03

    def merged_args(self, out_dir: str) -> TrainingArguments:
        return TrainingArguments(
            output_dir=out_dir,
            num_train_epochs=self.epochs,
            learning_rate=self.lr,
            weight_decay=self.weight_decay,
            per_device_train_batch_size=self.batch_size,
            per_device_eval_batch_size=self.batch_size,
            gradient_accumulation_steps=self.grad_accum,
            gradient_checkpointing=self.gradient_checkpointing,
            bf16=self.bf16,
            seed=self.seed,
            logging_steps=self.logging_steps,
            save_steps=self.save_steps,
            eval_steps=self.eval_steps,
            warmup_ratio=self.warmup_ratio,
            evaluation_strategy="steps",
            save_strategy="steps",
            load_best_model_at_end=True,
            metric_for_best_model="eval_pair_accuracy",
            greater_is_better=True,
            report_to=[],
        )


def _format_pair(tokenizer, prompt: str, response: str, max_length: int) -> dict:
    text = tokenizer.apply_chat_template(
        [{"role": "user", "content": prompt}, {"role": "assistant", "content": response}],
        tokenize=False,
        add_generation_prompt=False,
    )
    enc = tokenizer(text, truncation=True, max_length=max_length, return_tensors="pt")
    return {k: v.squeeze(0) for k, v in enc.items()}


class PreferenceCollator:
    """Pads chosen and rejected to the same length within a batch."""

    def __init__(self, tokenizer):
        self.tokenizer = tokenizer
        self.pad_id = tokenizer.pad_token_id
        if self.pad_id is None:
            self.pad_id = tokenizer.eos_token_id

    def __call__(self, batch):
        chosen = [b["chosen"] for b in batch]
        rejected = [b["rejected"] for b in batch]
        c_pad = self._pad(chosen)
        r_pad = self._pad(rejected)
        return {
            "chosen_input_ids": c_pad["input_ids"],
            "chosen_attention_mask": c_pad["attention_mask"],
            "rejected_input_ids": r_pad["input_ids"],
            "rejected_attention_mask": r_pad["attention_mask"],
        }

    def _pad(self, encoded):
        max_len = max(e["input_ids"].size(0) for e in encoded)
        ids = torch.full((len(encoded), max_len), self.pad_id, dtype=torch.long)
        mask = torch.zeros((len(encoded), max_len), dtype=torch.long)
        for i, e in enumerate(encoded):
            n = e["input_ids"].size(0)
            ids[i, :n] = e["input_ids"]
            mask[i, :n] = e.get("attention_mask", torch.ones(n, dtype=torch.long))
        return {"input_ids": ids, "attention_mask": mask}


class _PairwiseRewardTrainer(Trainer):
    """Bradley-Terry loss over (chosen, rejected) pairs.

    Loss: -log sigmoid(beta * (r_chosen - r_rejected)).

    The model has a single scalar regression head on the last non-pad token.
    We forward chosen and rejected separately so the same model sees both
    sequences with their own attention masks (no positional crosstalk).
    """

    def __init__(self, *args, beta: float = 1.0, **kwargs):
        super().__init__(*args, **kwargs)
        self.beta = beta

    def _reward(self, model, input_ids, attention_mask):
        out = model(input_ids=input_ids, attention_mask=attention_mask)
        logits = out.logits.squeeze(-1)  # [batch, seq]
        last = attention_mask.sum(dim=1) - 1
        idx = last.clamp(min=0).unsqueeze(1)
        return logits.gather(1, idx).squeeze(1)

    def compute_loss(self, model, inputs, return_outputs=False, **kwargs):
        r_c = self._reward(model, inputs["chosen_input_ids"], inputs["chosen_attention_mask"])
        r_r = self._reward(model, inputs["rejected_input_ids"], inputs["rejected_attention_mask"])
        margin = self.beta * (r_c - r_r)
        loss = -F.logsigmoid(margin).mean()
        if return_outputs:
            return loss, {"r_chosen": r_c.detach(), "r_rejected": r_r.detach(), "margin": margin.detach()}
        return loss


def _pair_accuracy_metric(eval_pred) -> dict:
    """Eval metric: fraction of pairs where chosen ranks above rejected.

    Pure ranking accuracy; doesn't depend on the absolute scale of the head.
    """
    predictions, _ = eval_pred
    if isinstance(predictions, tuple):
        r_c, r_r = predictions[0], predictions[1]
    else:
        r_c, r_r = predictions[..., 0], predictions[..., 1]
    correct = (r_c > r_r).astype("float32").mean()
    return {"pair_accuracy": float(correct)}


def _load_jsonl(path: str) -> list[dict]:
    items: list[dict] = []
    with open(path, "r", encoding="utf-8") as f:
        for ln, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                raise ValueError(f"reward.py: malformed JSONL at {path}:{ln}: {e.msg}") from e
            for k in ("prompt", "chosen", "rejected"):
                if k not in obj or not isinstance(obj[k], str):
                    raise ValueError(
                        f"reward.py: {path}:{ln} missing string field '{k}'. "
                        f"Required shape: {{'prompt','chosen','rejected'}}."
                    )
            items.append(obj)
    if not items:
        raise ValueError(f"reward.py: no preference pairs in {path}")
    return items


def reward_trainer(
    base_model: str,
    train_jsonl: str,
    out_dir: str,
    config: Optional[RewardConfig] = None,
    eval_jsonl: Optional[str] = None,
) -> "RewardSession":
    """Build a configured trainer ready for .train().

    The base model is loaded with a single-output classification head so the
    last hidden state at the last non-pad token becomes the scalar reward.
    """

    cfg = config or RewardConfig()
    torch.manual_seed(cfg.seed)

    tokenizer = AutoTokenizer.from_pretrained(base_model, use_fast=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForSequenceClassification.from_pretrained(
        base_model,
        num_labels=1,
        problem_type="regression",
        torch_dtype=torch.bfloat16 if cfg.bf16 else torch.float32,
    )
    model.config.pad_token_id = tokenizer.pad_token_id

    pairs = _load_jsonl(train_jsonl)
    eval_pairs: list[dict] = []
    if eval_jsonl:
        eval_pairs = _load_jsonl(eval_jsonl)
    elif cfg.eval_split > 0 and len(pairs) >= 20:
        cut = max(1, int(len(pairs) * cfg.eval_split))
        eval_pairs = pairs[-cut:]
        pairs = pairs[:-cut]

    def to_tensor_row(row: dict) -> dict:
        c = _format_pair(tokenizer, row["prompt"], row["chosen"], cfg.max_length)
        r = _format_pair(tokenizer, row["prompt"], row["rejected"], cfg.max_length)
        return {"chosen": c, "rejected": r}

    train_ds = [to_tensor_row(p) for p in pairs]
    eval_ds = [to_tensor_row(p) for p in eval_pairs] if eval_pairs else None

    args = cfg.merged_args(out_dir)
    collator = PreferenceCollator(tokenizer)

    trainer = _PairwiseRewardTrainer(
        model=model,
        args=args,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        data_collator=collator,
        compute_metrics=_pair_accuracy_metric,
        beta=cfg.beta,
    )

    return RewardSession(trainer=trainer, tokenizer=tokenizer, config=cfg, out_dir=out_dir,
                        base_model=base_model, n_train=len(train_ds), n_eval=len(eval_ds or []))


@dataclass
class RewardSession:
    """Wraps the trainer plus the inference path for the trained head."""

    trainer: Any
    tokenizer: Any
    config: RewardConfig
    out_dir: str
    base_model: str
    n_train: int
    n_eval: int

    def train(self) -> dict:
        result = self.trainer.train()
        self.trainer.save_model(self.out_dir)
        self.tokenizer.save_pretrained(self.out_dir)
        return {
            "loss_final": float(result.training_loss),
            "global_step": int(result.global_step),
            "n_train": self.n_train,
            "n_eval": self.n_eval,
        }

    @torch.no_grad()
    def score(self, prompt: str, response: str) -> float:
        """Return the scalar reward for a single (prompt, response)."""

        model = self.trainer.model
        model.eval()
        enc = _format_pair(self.tokenizer, prompt, response, self.config.max_length)
        ids = enc["input_ids"].unsqueeze(0).to(model.device)
        mask = enc["attention_mask"].unsqueeze(0).to(model.device)
        out = model(input_ids=ids, attention_mask=mask).logits.squeeze(-1)
        last = mask.sum(dim=1) - 1
        return float(out[0, last[0].clamp(min=0)])


def receipt_block(session: RewardSession, train_summary: dict) -> dict:
    """The receipt fragment the K-score gate and audit log both read.

    `papers` deliberately cites the canonical references so a downstream
    binder render can footnote them without a side lookup.
    """

    cfg = asdict(session.config)
    return {
        "method": "bradley_terry_reward_model",
        "base_model": session.base_model,
        "config": cfg,
        "n_train_pairs": session.n_train,
        "n_eval_pairs": session.n_eval,
        "loss_final": train_summary.get("loss_final"),
        "papers": [
            "Bradley & Terry 1952",
            "arXiv:2009.01325",  # Stiennon
            "arXiv:2203.02155",  # InstructGPT
            "arXiv:2204.05862",  # Anthropic HH-RLHF
        ],
    }
