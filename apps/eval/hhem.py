"""
apps/eval/hhem.py

Hallucination detection.

For tasks where the model is supposed to summarize / answer based on a given
context (RAG, doc-QA, support-ticket reply), we need to know whether the
output is *grounded* in the context or invented. Two approaches:

  1. NLI-style premise/hypothesis scoring with a strong open model.
     Vectara's HHEM-2.1 (open weights, Apache-2.0) is the current public SOTA.
     It returns p(hypothesis-entailed-by-premise) in [0,1].
       https://huggingface.co/vectara/hallucination_evaluation_model

  2. Claim-decomposed scoring (RAGTruth-style): split the output into atomic
     claims, score each against the context, and aggregate.
       Niu et al 2024, arXiv:2401.00396

This module exposes both. The NLI scorer is the fast default; claim
decomposition kicks in when the user asks for `granularity="claim"`.

The scorer never needs the original training data. It compares the model's
output (hypothesis) against the input context (premise).

Receipt provenance:
  {
    "type": "hhem",
    "model": "vectara/hallucination_evaluation_model",
    "granularity": "doc",
    "score": 0.91,
    "label": "supported"
  }
"""

from __future__ import annotations

import dataclasses
import enum
import logging
import re
from typing import Any, Iterable, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)


class HhemLabel(str, enum.Enum):
    SUPPORTED = "supported"      # output entailed by context
    UNSUPPORTED = "unsupported"  # neither entailed nor contradicted
    CONTRADICTORY = "contradictory"


@dataclasses.dataclass(frozen=True)
class HhemConfig:
    model: str = "vectara/hallucination_evaluation_model"
    granularity: str = "doc"     # "doc" or "claim"
    threshold_supported: float = 0.5
    threshold_contradicted: float = 0.10
    max_premise_chars: int = 16000
    max_hypothesis_chars: int = 4000
    device: Optional[str] = None  # "cpu" | "cuda" | None=auto


@dataclasses.dataclass(frozen=True)
class ClaimScore:
    claim: str
    score: float
    label: HhemLabel


@dataclasses.dataclass(frozen=True)
class HhemResult:
    score: float                          # 0..1 grounding score
    label: HhemLabel
    granularity: str                      # "doc" | "claim"
    claims: tuple[ClaimScore, ...] = ()
    model: str = ""


# ----- model loader (lazy) -----------------------------------------------


_MODEL_CACHE: dict[str, Any] = {}


def _load_model(cfg: HhemConfig):
    key = f"{cfg.model}::{cfg.device or 'auto'}"
    if key in _MODEL_CACHE:
        return _MODEL_CACHE[key]
    try:
        from transformers import AutoModelForSequenceClassification, AutoTokenizer
        import torch
    except ImportError as exc:
        raise RuntimeError(
            "hhem needs transformers and torch. "
            "Run `pip install transformers>=4.40 torch` and retry."
        ) from exc

    tok = AutoTokenizer.from_pretrained(cfg.model)
    mdl = AutoModelForSequenceClassification.from_pretrained(cfg.model, trust_remote_code=True)
    if cfg.device:
        mdl = mdl.to(cfg.device)
    elif torch.cuda.is_available():
        mdl = mdl.to("cuda")
    mdl.eval()
    _MODEL_CACHE[key] = (tok, mdl, torch)
    return _MODEL_CACHE[key]


def _score_one(cfg: HhemConfig, premise: str, hypothesis: str) -> float:
    """Return the HHEM-style probability that hypothesis is supported by premise."""
    tok, mdl, torch = _load_model(cfg)
    premise = (premise or "")[: cfg.max_premise_chars]
    hypothesis = (hypothesis or "")[: cfg.max_hypothesis_chars]
    # HHEM-2.1 uses a structured prompt: "premise: <P> hypothesis: <H>"
    prompt = f"premise: {premise} hypothesis: {hypothesis}"
    inputs = tok(prompt, return_tensors="pt", truncation=True, max_length=4096)
    inputs = {k: v.to(mdl.device) for k, v in inputs.items()}
    with torch.no_grad():
        out = mdl(**inputs)
    logit = out.logits.squeeze().float()
    if logit.ndim == 0:
        score = torch.sigmoid(logit).item()
    else:
        score = torch.softmax(logit, dim=-1)[-1].item()
    return float(score)


# ----- claim decomposition ------------------------------------------------


_SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?])\s+(?=[A-Z(])")


def split_into_claims(text: str) -> list[str]:
    """
    Tokenise `text` into atomic claims. Sentence-level split is sufficient
    for most outputs; downstream callers can swap in a stronger splitter
    (e.g., a small LLM-based atomiser) by passing pre-split claims directly.
    """
    if not text:
        return []
    raw = _SENTENCE_BOUNDARY.split(text.strip())
    return [s.strip() for s in raw if s.strip()]


# ----- entry points -------------------------------------------------------


def score(context: str, output: str, cfg: Optional[HhemConfig] = None) -> HhemResult:
    """
    Score a single (context, output) pair. cfg.granularity controls whether
    the score is at the document level or aggregated across atomic claims.
    """
    cfg = cfg or HhemConfig()
    if cfg.granularity == "claim":
        return _score_claims(context, output, cfg)
    s = _score_one(cfg, context, output)
    return HhemResult(
        score=round(s, 4),
        label=_label(s, cfg),
        granularity="doc",
        model=cfg.model,
    )


def _score_claims(context: str, output: str, cfg: HhemConfig) -> HhemResult:
    claims = split_into_claims(output)
    if not claims:
        return HhemResult(score=1.0, label=HhemLabel.SUPPORTED, granularity="claim", model=cfg.model)
    rows: list[ClaimScore] = []
    for c in claims:
        s = _score_one(cfg, context, c)
        rows.append(ClaimScore(claim=c, score=round(s, 4), label=_label(s, cfg)))
    # Aggregate as the minimum: any unsupported claim drags down the whole.
    # This is conservative and right for safety-critical use; callers can
    # post-process the per-claim list for friendlier UX.
    agg = min(r.score for r in rows)
    return HhemResult(
        score=round(agg, 4),
        label=_label(agg, cfg),
        granularity="claim",
        claims=tuple(rows),
        model=cfg.model,
    )


def _label(s: float, cfg: HhemConfig) -> HhemLabel:
    if s < cfg.threshold_contradicted:
        return HhemLabel.CONTRADICTORY
    if s < cfg.threshold_supported:
        return HhemLabel.UNSUPPORTED
    return HhemLabel.SUPPORTED


def score_batch(
    pairs: Iterable[Mapping[str, str]],
    cfg: Optional[HhemConfig] = None,
) -> list[HhemResult]:
    """
    Score a list of {"context", "output"} pairs. Returns a list of HhemResult
    in the same order.
    """
    cfg = cfg or HhemConfig()
    return [score(p["context"], p["output"], cfg) for p in pairs]


def aggregate(results: Sequence[HhemResult]) -> dict[str, Any]:
    """Aggregate HhemResults into a single rollup dict for receipt provenance."""
    if not results:
        return {"items": 0, "mean_score": 0.0, "supported_rate": 0.0, "contradicted_rate": 0.0}
    n = len(results)
    mean = sum(r.score for r in results) / n
    supported = sum(1 for r in results if r.label is HhemLabel.SUPPORTED)
    contradicted = sum(1 for r in results if r.label is HhemLabel.CONTRADICTORY)
    return {
        "items": n,
        "mean_score": round(mean, 4),
        "supported_rate": round(supported / n, 4),
        "contradicted_rate": round(contradicted / n, 4),
    }


def receipt_record(result: HhemResult) -> dict:
    return {
        "type": "hhem",
        "model": result.model,
        "granularity": result.granularity,
        "score": result.score,
        "label": result.label.value,
    }


__all__ = [
    "HhemLabel",
    "HhemConfig",
    "HhemResult",
    "ClaimScore",
    "score",
    "score_batch",
    "split_into_claims",
    "aggregate",
    "receipt_record",
]
