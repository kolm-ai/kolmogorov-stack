"""
apps/trainer/reranker.py

Cross-encoder reranker fine-tuning.

After bi-encoder retrieval returns the top-100, a cross-encoder scores each
(query, passage) pair as one sequence and reorders them. Cross-encoders are
10-100x slower than bi-encoders per pair (full attention over the
concatenated sequence) but trade that speed for noticeably higher precision
on the top-10 the user actually sees.

Two training shapes are supported:

    binary       (query, passage, label in {0,1}). Binary cross-entropy on
                 the scalar relevance score. Easiest to label.

    pointwise    (query, passage, label in [0,1]) or (query, passage, score
                 in any real range). MSE on the score. Use when you have
                 graded relevance judgments (e.g. NDCG-style 0/1/2/3).

For ranking-loss training (margin between pos and neg in the same query),
prefer apps/trainer/embedding.py with loss_shape='triplet'. Cross-encoders
typically don't beat that loss for ranking; they beat it on absolute
relevance scoring, which is what reranking needs.

Surface:

    from apps.trainer.reranker import reranker_trainer, RerankConfig

    trainer = reranker_trainer(
        model_id="BAAI/bge-reranker-v2-m3",
        train_dataset=labeled_pairs,
        config=RerankConfig(shape="binary"),
    )
    trainer.train()

Citations:
  monoBERT (cross-encoder):    Nogueira & Cho 2019, arXiv:1901.04085
  BGE reranker:                Chen et al 2024, arXiv:2402.03216
  Cross-encoder distillation:  Hofstatter et al 2021, arXiv:2010.02666
"""

from __future__ import annotations

import dataclasses
import logging
from typing import Any, Iterable, Literal, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)

LossShape = Literal["binary", "pointwise"]


@dataclasses.dataclass(frozen=True)
class RerankConfig:
    shape: LossShape = "binary"
    learning_rate: float = 1e-5
    num_train_epochs: int = 1
    per_device_train_batch_size: int = 16
    gradient_accumulation_steps: int = 1
    max_seq_length: int = 512
    warmup_ratio: float = 0.1
    weight_decay: float = 0.01
    logging_steps: int = 10
    save_steps: int = 200
    bf16: bool = True
    output_dir: str = "./out/reranker"
    seed: int = 42


def _import_transformers():
    try:
        import transformers  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "transformers is not installed. install with: "
            "pip install 'transformers>=4.45.0'"
        ) from e
    return transformers


def _import_torch():
    try:
        import torch  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "torch is not installed. install with: pip install torch"
        ) from e
    return torch


class RerankerTrainer:
    """
    Cross-encoder trainer. Wraps AutoModelForSequenceClassification with
    num_labels=1 (regression head). Loss is BCE for shape=binary, MSE for
    shape=pointwise; both branches operate on the same single-logit head.

    Dataset format:

        [{"query": str, "passage": str, "label": float}, ...]
    """

    def __init__(
        self,
        *,
        model_id: str,
        train_dataset: Sequence[Mapping[str, Any]],
        config: Optional[RerankConfig] = None,
        eval_dataset: Optional[Sequence[Mapping[str, Any]]] = None,
    ):
        self.config = config or RerankConfig()
        self.model_id = model_id
        self.train_dataset = list(train_dataset)
        self.eval_dataset = list(eval_dataset) if eval_dataset else None
        self._validate()
        self._transformers = _import_transformers()
        self._torch = _import_torch()
        self.tokenizer = self._transformers.AutoTokenizer.from_pretrained(model_id)
        self.model = self._transformers.AutoModelForSequenceClassification.from_pretrained(
            model_id,
            num_labels=1,
            torch_dtype=self._torch.bfloat16 if self.config.bf16 else self._torch.float32,
        )

    def _validate(self) -> None:
        for i, ex in enumerate(self.train_dataset[:8]):
            for k in ("query", "passage", "label"):
                if k not in ex:
                    raise ValueError(f"train_dataset[{i}] missing {k!r}")
            try:
                v = float(ex["label"])
            except (TypeError, ValueError):
                raise ValueError(
                    f"train_dataset[{i}].label must be numeric, got {ex['label']!r}"
                )
            if self.config.shape == "binary" and v not in (0.0, 1.0):
                raise ValueError(
                    f"shape=binary requires labels in {{0,1}}; "
                    f"got {v} at index {i}. Use shape=pointwise for graded."
                )

    def score(self, query: str, passage: str) -> float:
        """Score a single (query, passage) pair. Inference helper."""
        torch = self._torch
        inputs = self.tokenizer(
            query,
            passage,
            truncation=True,
            padding=True,
            max_length=self.config.max_seq_length,
            return_tensors="pt",
        ).to(self.model.device)
        with torch.inference_mode():
            logits = self.model(**inputs).logits.squeeze(-1)
        if self.config.shape == "binary":
            return float(torch.sigmoid(logits).cpu().item())
        return float(logits.cpu().item())

    def compute_loss(self, batch: Sequence[Mapping[str, Any]]) -> Any:
        torch = self._torch
        queries = [str(ex["query"]) for ex in batch]
        passages = [str(ex["passage"]) for ex in batch]
        labels = torch.tensor([float(ex["label"]) for ex in batch], dtype=torch.float32)
        inputs = self.tokenizer(
            queries,
            passages,
            truncation=True,
            padding=True,
            max_length=self.config.max_seq_length,
            return_tensors="pt",
        ).to(self.model.device)
        labels = labels.to(self.model.device)
        logits = self.model(**inputs).logits.squeeze(-1)
        if self.config.shape == "binary":
            return torch.nn.functional.binary_cross_entropy_with_logits(logits, labels)
        return torch.nn.functional.mse_loss(logits, labels)

    def train(self) -> dict[str, Any]:
        torch = self._torch
        optimizer = torch.optim.AdamW(
            self.model.parameters(),
            lr=self.config.learning_rate,
            weight_decay=self.config.weight_decay,
        )
        self.model.train()
        step = 0
        last_loss = None
        bs = self.config.per_device_train_batch_size
        for epoch in range(self.config.num_train_epochs):
            for i in range(0, len(self.train_dataset), bs):
                batch = self.train_dataset[i : i + bs]
                if not batch:
                    continue
                loss = self.compute_loss(batch)
                loss.backward()
                optimizer.step()
                optimizer.zero_grad()
                step += 1
                last_loss = float(loss.detach().cpu())
                if step % self.config.logging_steps == 0:
                    logger.info("step=%d epoch=%d loss=%.6f", step, epoch, last_loss)
        return {"steps": step, "final_loss": last_loss}


def reranker_trainer(
    *,
    model_id: str,
    train_dataset: Sequence[Mapping[str, Any]],
    config: Optional[RerankConfig] = None,
    eval_dataset: Optional[Sequence[Mapping[str, Any]]] = None,
) -> RerankerTrainer:
    return RerankerTrainer(
        model_id=model_id,
        train_dataset=train_dataset,
        config=config,
        eval_dataset=eval_dataset,
    )


def receipt_block(
    cfg: RerankConfig,
    *,
    model_id: str,
    train_examples: int,
    final_loss: Optional[float] = None,
) -> dict[str, Any]:
    return {
        "algo": "reranker_cross_encoder",
        "model_id": model_id,
        "config": dataclasses.asdict(cfg),
        "train_examples": int(train_examples),
        "final_loss": float(final_loss) if final_loss is not None else None,
        "papers": [
            "arXiv:1901.04085",  # monoBERT
            "arXiv:2402.03216",  # BGE reranker
            "arXiv:2010.02666",  # cross-encoder distillation
        ],
        "schema_version": "reranker.v1",
    }


__all__ = [
    "RerankConfig",
    "LossShape",
    "RerankerTrainer",
    "reranker_trainer",
    "receipt_block",
]
