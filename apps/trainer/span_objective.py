"""UL2-style span corruption training objective.

The default SFT path trains next-token-prediction over user/assistant pairs.
That is a per-token objective. For knowledge-base ingestion (where the goal
is "model knows facts about our company") that is suboptimal: you train the
model to memorize one token at a time, conditioned on long context.

Span corruption trains the model to fill in masked SPANS (sentence-sized
chunks). This is closer to what the user actually cares about: "given this
context window, the model should be able to produce sentence-length facts".

Trade-offs:
  * SFT is better when there are clean (prompt, completion) pairs.
  * Span is better when you have free-form corpora (PDFs, docs, transcripts)
    and want the model to ABSORB facts before instruction tuning.
  * Most kolm pipelines combine the two: span on raw corpus, then SFT on
    instruction pairs synthesized from that corpus.

Selection: KOLM_TRAIN_OBJECTIVE=span enables this path.
"""

from __future__ import annotations

import os
import random
from dataclasses import dataclass
from typing import Any, Iterable


@dataclass
class SpanConfig:
    mean_span_len: int = 16
    mask_ratio: float = 0.15
    seed: int = 42

    @classmethod
    def from_env(cls) -> "SpanConfig":
        return cls(
            mean_span_len=int(os.environ.get("KOLM_SPAN_MEAN_LEN", "16")),
            mask_ratio=float(os.environ.get("KOLM_SPAN_MASK_RATIO", "0.15")),
            seed=int(os.environ.get("KOLM_SEED", "42")),
        )


SENTINEL = "<extra_id_{i}>"


def corrupt_tokens(token_ids: list[int], tokenizer, cfg: SpanConfig, rng: random.Random) -> tuple[list[int], list[int]]:
    """Return (corrupted_input, target).

    The target is the concatenated masked spans, each prefixed by a sentinel.
    """
    n = len(token_ids)
    if n < cfg.mean_span_len * 2:
        return token_ids, []

    n_mask = int(n * cfg.mask_ratio)
    n_spans = max(1, n_mask // cfg.mean_span_len)
    starts = sorted(rng.sample(range(n - cfg.mean_span_len), n_spans))

    # Merge overlapping spans.
    merged: list[tuple[int, int]] = []
    for s in starts:
        e = s + cfg.mean_span_len
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))

    corrupted: list[int] = []
    target: list[int] = []
    cur = 0
    for i, (s, e) in enumerate(merged):
        corrupted.extend(token_ids[cur:s])
        sentinel_token = tokenizer.encode(SENTINEL.format(i=i), add_special_tokens=False)
        corrupted.extend(sentinel_token)
        target.extend(sentinel_token)
        target.extend(token_ids[s:e])
        cur = e
    corrupted.extend(token_ids[cur:])
    # Append a final sentinel as EOS.
    final = tokenizer.encode(SENTINEL.format(i=len(merged)), add_special_tokens=False)
    target.extend(final)
    if tokenizer.eos_token_id is not None:
        target.append(tokenizer.eos_token_id)

    return corrupted, target


def span_pairs(corpus_text: Iterable[str], tokenizer, cfg: SpanConfig) -> list[dict[str, Any]]:
    """Apply span corruption to each document; return SFT-shaped pairs.

    Output is {"prompt": "<corrupted>", "completion": "<targets>"} so the
    existing SFTTrainer code path can train on it without changes.
    """
    rng = random.Random(cfg.seed)
    out: list[dict[str, Any]] = []
    for doc in corpus_text:
        if not doc.strip():
            continue
        ids = tokenizer.encode(doc, add_special_tokens=False)
        ci, ti = corrupt_tokens(ids, tokenizer, cfg, rng)
        if not ti:
            continue
        prompt = tokenizer.decode(ci, skip_special_tokens=False)
        completion = tokenizer.decode(ti, skip_special_tokens=False)
        out.append({"prompt": prompt, "completion": completion})
    return out
