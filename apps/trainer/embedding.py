"""
apps/trainer/embedding.py

Embedding model fine-tuning. InfoNCE contrastive loss + Matryoshka heads.

The standard RAG stack uses a bi-encoder for first-stage retrieval (fast,
sublinear vector search) and a cross-encoder reranker for top-K reordering
(slow, exact). This module trains the first stage. The companion module
apps/trainer/reranker.py trains the second.

The training signal is contrastive: for each anchor, pull the positive close,
push negatives far. We support two negative-sampling shapes:

    triplet           (anchor, positive, negative) — one explicit negative per
                      example. Best when you have curated hard negatives.

    in_batch          (anchor, positive) — every other positive in the same
                      batch becomes a negative for this anchor. Common when
                      labels are noisy or you have a lot of pairs.

The loss is InfoNCE (Oord 2018, arXiv:1807.03748). For each anchor,
log-softmax over (sim(a,p) + sim(a,negatives)). Temperature is the standard
1/scale knob.

Matryoshka Representation Learning (Kusupati 2022, arXiv:2205.13147) is the
clever extra: train the encoder so that the first 64 dims of the embedding
also work as a 64-dim representation, and the first 128 dims work as 128,
and so on. One encoder, multiple deployment costs. Buyers with tight
memory pick a small cut; quality buyers use the full vector.

Surface:

    from apps.trainer.embedding import embedding_trainer, EmbedConfig

    trainer = embedding_trainer(
        model_id="sentence-transformers/all-mpnet-base-v2",
        train_dataset=triplets,
        config=EmbedConfig(
            matryoshka_dims=[64, 128, 256, 512, 768],
            temperature=0.05,
        ),
    )
    trainer.train()

Citations:
  InfoNCE:        Oord et al 2018, arXiv:1807.03748
  Matryoshka:     Kusupati et al 2022, arXiv:2205.13147
  GTE:            Li et al 2023, arXiv:2308.03281
  Sentence-BERT:  Reimers & Gurevych 2019, arXiv:1908.10084
"""

from __future__ import annotations

import dataclasses
import logging
from typing import Any, Iterable, Literal, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)

LossShape = Literal["triplet", "in_batch"]


@dataclasses.dataclass(frozen=True)
class EmbedConfig:
    """
    Stable training config for the embedding trainer.

    matryoshka_dims     list of nested dims for MRL. If None, train at full dim
                        only. Standard ladder is [64, 128, 256, 512, 768].
    temperature         InfoNCE softmax temperature
    loss_shape          'triplet' or 'in_batch'
    pooling             'cls' | 'mean' | 'last_token' — must match the base
                        model's training convention
    normalize           L2-normalize embeddings before scoring (cosine sim)
    """

    matryoshka_dims: Optional[tuple[int, ...]] = (64, 128, 256, 512, 768)
    temperature: float = 0.05
    loss_shape: LossShape = "triplet"
    pooling: Literal["cls", "mean", "last_token"] = "mean"
    normalize: bool = True

    learning_rate: float = 2e-5
    num_train_epochs: int = 1
    per_device_train_batch_size: int = 32
    gradient_accumulation_steps: int = 1
    max_seq_length: int = 512
    warmup_ratio: float = 0.06
    weight_decay: float = 0.01
    logging_steps: int = 10
    save_steps: int = 200

    bf16: bool = True
    output_dir: str = "./out/embedding"
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


def _pool(hidden: Any, mask: Any, pooling: str, torch):
    """Pool a (batch, seq, dim) tensor down to (batch, dim)."""
    if pooling == "cls":
        return hidden[:, 0]
    if pooling == "mean":
        m = mask.unsqueeze(-1).float()
        return (hidden * m).sum(dim=1) / m.sum(dim=1).clamp_min(1.0)
    if pooling == "last_token":
        # last non-pad position per row
        seq_lens = mask.sum(dim=1) - 1
        idx = seq_lens.unsqueeze(-1).unsqueeze(-1).expand(-1, 1, hidden.shape[-1])
        return hidden.gather(1, idx).squeeze(1)
    raise ValueError(f"unknown pooling: {pooling}")


class EmbeddingTrainer:
    """
    Thin trainer that wraps a HuggingFace encoder + contrastive loop.

    Caller can subclass or just use .train() with a list of dicts.

    Dataset format:

        triplet:   [{"anchor": str, "positive": str, "negative": str}, ...]
        in_batch:  [{"anchor": str, "positive": str}, ...]
    """

    def __init__(
        self,
        *,
        model_id: str,
        train_dataset: Sequence[Mapping[str, str]],
        config: Optional[EmbedConfig] = None,
        eval_dataset: Optional[Sequence[Mapping[str, str]]] = None,
    ):
        self.config = config or EmbedConfig()
        self.model_id = model_id
        self.train_dataset = list(train_dataset)
        self.eval_dataset = list(eval_dataset) if eval_dataset else None
        self._validate_dataset()
        self._transformers = _import_transformers()
        self._torch = _import_torch()
        self.tokenizer = self._transformers.AutoTokenizer.from_pretrained(model_id)
        self.model = self._transformers.AutoModel.from_pretrained(
            model_id,
            torch_dtype=self._torch.bfloat16 if self.config.bf16 else self._torch.float32,
        )

    def _validate_dataset(self) -> None:
        required = (
            ("anchor", "positive", "negative")
            if self.config.loss_shape == "triplet"
            else ("anchor", "positive")
        )
        for i, ex in enumerate(self.train_dataset[:8]):
            for k in required:
                if k not in ex:
                    raise ValueError(
                        f"train_dataset[{i}] missing key {k!r} for loss_shape="
                        f"{self.config.loss_shape}"
                    )

    def encode(self, texts: Sequence[str]) -> Any:
        """Encode a batch of strings to embeddings."""
        torch = self._torch
        inputs = self.tokenizer(
            list(texts),
            padding=True,
            truncation=True,
            max_length=self.config.max_seq_length,
            return_tensors="pt",
        ).to(self.model.device)
        out = self.model(**inputs)
        emb = _pool(out.last_hidden_state, inputs["attention_mask"], self.config.pooling, torch)
        if self.config.normalize:
            emb = torch.nn.functional.normalize(emb, p=2, dim=-1)
        return emb

    def compute_loss(self, batch: Sequence[Mapping[str, str]]) -> Any:
        """
        InfoNCE loss with optional Matryoshka heads.

        For triplet: sim(a,p)/T vs {sim(a,p)/T, sim(a,n)/T}. The "positive"
        index is 0 by construction.

        For in_batch: sim(a_i, p_j) for all j in the batch; positive is i.
        """
        torch = self._torch
        anchors = [ex["anchor"] for ex in batch]
        positives = [ex["positive"] for ex in batch]
        a_emb = self.encode(anchors)
        p_emb = self.encode(positives)

        if self.config.loss_shape == "triplet":
            negatives = [ex["negative"] for ex in batch]
            n_emb = self.encode(negatives)
        else:
            n_emb = None

        total = None
        dims = list(self.config.matryoshka_dims) if self.config.matryoshka_dims else [a_emb.shape[-1]]
        for d in dims:
            a, p = a_emb[..., :d], p_emb[..., :d]
            if self.config.normalize:
                a = torch.nn.functional.normalize(a, p=2, dim=-1)
                p = torch.nn.functional.normalize(p, p=2, dim=-1)
            if self.config.loss_shape == "triplet":
                n = n_emb[..., :d]
                if self.config.normalize:
                    n = torch.nn.functional.normalize(n, p=2, dim=-1)
                sim_pos = (a * p).sum(-1, keepdim=True) / self.config.temperature
                sim_neg = (a * n).sum(-1, keepdim=True) / self.config.temperature
                logits = torch.cat([sim_pos, sim_neg], dim=-1)
                labels = torch.zeros(logits.shape[0], dtype=torch.long, device=logits.device)
            else:
                logits = (a @ p.transpose(0, 1)) / self.config.temperature
                labels = torch.arange(logits.shape[0], device=logits.device)
            loss_d = torch.nn.functional.cross_entropy(logits, labels)
            total = loss_d if total is None else total + loss_d
        return total / len(dims)

    def train(self) -> dict[str, Any]:
        """
        Lightweight in-house loop. Production buyers should swap in
        transformers.Trainer; this works for unit-tests and small datasets.
        """
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
                if len(batch) < 2 and self.config.loss_shape == "in_batch":
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


def embedding_trainer(
    *,
    model_id: str,
    train_dataset: Sequence[Mapping[str, str]],
    config: Optional[EmbedConfig] = None,
    eval_dataset: Optional[Sequence[Mapping[str, str]]] = None,
) -> EmbeddingTrainer:
    """Public factory mirroring the trl-trainer surface in this codebase."""
    return EmbeddingTrainer(
        model_id=model_id,
        train_dataset=train_dataset,
        config=config,
        eval_dataset=eval_dataset,
    )


def receipt_block(
    cfg: EmbedConfig,
    *,
    model_id: str,
    train_examples: int,
    final_loss: Optional[float] = None,
) -> dict[str, Any]:
    return {
        "algo": "embedding_contrastive",
        "model_id": model_id,
        "config": dataclasses.asdict(cfg),
        "train_examples": int(train_examples),
        "final_loss": float(final_loss) if final_loss is not None else None,
        "papers": [
            "arXiv:1807.03748",  # InfoNCE
            "arXiv:2205.13147",  # Matryoshka
            "arXiv:2308.03281",  # GTE
            "arXiv:1908.10084",  # Sentence-BERT
        ],
        "schema_version": "embedding.v1",
    }


__all__ = [
    "EmbedConfig",
    "LossShape",
    "EmbeddingTrainer",
    "embedding_trainer",
    "receipt_block",
]
