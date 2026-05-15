"""
apps/eval/judge.py

LLM-as-judge evaluation mode.

K-score is the kolm flagship: a deterministic, reproducible score from
explicit rubrics on captured eval cases. It is the right floor for shipping
gate decisions. It is not, on its own, a complete eval — some properties
("does this response feel helpful?", "is the explanation clear?") need a
strong judge model.

This module ships two patterns from the public lit:

  pointwise   one judge rates each output on a 1-10 rubric, optionally
              with chain-of-thought (Zheng et al, MT-Bench, 2023).
  pairwise    judge compares two outputs A vs B for the same prompt and
              picks a winner (Chatbot Arena, Zheng et al 2023). Bias-
              corrected by running both (A,B) and (B,A) and averaging.

Output is a JudgeResult that slots into the receipts schema. K-score is
**not** modified; the judge metric is reported alongside as `judge_score`
(0-1 normalized) so it can be inspected without poisoning the gate.

Backends: any model with an OpenAI-shaped /v1/chat/completions endpoint
works (OpenAI, Anthropic via litellm, vLLM, a local kolm serve). The judge
config carries the endpoint, model, and a budget cap.

References:
  - MT-Bench / Chatbot Arena: Zheng et al 2023, arXiv:2306.05685
  - G-Eval: Liu et al 2023, arXiv:2303.16634
  - JudgeBench: Tan et al 2024, arXiv:2410.12784 (judge-of-judge calibration)
"""

from __future__ import annotations

import dataclasses
import enum
import json
import logging
import math
import os
import re
import time
import urllib.error
import urllib.request
from typing import Any, Iterable, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)


class JudgeMode(str, enum.Enum):
    POINTWISE = "pointwise"
    PAIRWISE = "pairwise"


@dataclasses.dataclass(frozen=True)
class JudgeConfig:
    mode: JudgeMode = JudgeMode.POINTWISE
    base_url: str = "https://api.openai.com/v1"
    model: str = "gpt-4o-mini"
    api_key_env: str = "OPENAI_API_KEY"
    temperature: float = 0.0
    max_tokens: int = 512
    bias_correct_pairwise: bool = True
    rubric: Optional[str] = None
    request_timeout_s: float = 60.0
    max_requests: int = 1000  # safety: stop the run if a runaway exceeds this


DEFAULT_POINTWISE_RUBRIC = """\
You are evaluating an AI assistant's response.

Score the response on a scale of 1 to 10, where:
  1-3  = wrong, off-topic, harmful, or unhelpful
  4-6  = partially correct or partially relevant; missing important elements
  7-8  = correct and helpful; minor issues
  9-10 = excellent: correct, complete, well-organized, no issues

Be a strict judge. Most responses do NOT deserve a 9 or 10.

Respond with EXACTLY this JSON, no other text:
{"reasoning": "<one or two sentences>", "score": <integer 1-10>}
"""

DEFAULT_PAIRWISE_RUBRIC = """\
You are comparing two AI assistant responses to the same user request.

Decide which response is better. Consider:
  - correctness  (does it actually solve the request?)
  - completeness (does it address all parts?)
  - clarity      (is it organized, easy to read?)
  - safety       (is it free of harmful or misleading content?)

Pick exactly one verdict from: "A", "B", or "tie".
A "tie" should be rare; prefer to pick A or B unless the two are genuinely interchangeable.

Respond with EXACTLY this JSON, no other text:
{"reasoning": "<one or two sentences>", "verdict": "A" | "B" | "tie"}
"""


@dataclasses.dataclass(frozen=True)
class PointwiseScore:
    score: int          # 1-10
    reasoning: str
    raw: str
    cost_usd: float


@dataclasses.dataclass(frozen=True)
class PairwiseScore:
    verdict: str        # "A" | "B" | "tie"
    reasoning: str
    raw: str
    cost_usd: float


@dataclasses.dataclass(frozen=True)
class JudgeResult:
    mode: JudgeMode
    pointwise: tuple[PointwiseScore, ...] = ()
    pairwise: tuple[PairwiseScore, ...] = ()
    items: int = 0
    total_cost_usd: float = 0.0
    judge_score: float = 0.0   # normalized 0..1
    tie_rate: float = 0.0
    a_wins: int = 0
    b_wins: int = 0
    ties: int = 0


# ----- prompt builders ----------------------------------------------------


def _pointwise_messages(prompt: str, response: str, rubric: str) -> list[dict]:
    return [
        {"role": "system", "content": rubric.strip()},
        {
            "role": "user",
            "content": f"Prompt:\n{prompt}\n\nResponse:\n{response}\n\nReturn only the JSON.",
        },
    ]


def _pairwise_messages(prompt: str, a: str, b: str, rubric: str) -> list[dict]:
    return [
        {"role": "system", "content": rubric.strip()},
        {
            "role": "user",
            "content": (
                f"Prompt:\n{prompt}\n\n"
                f"Response A:\n{a}\n\n"
                f"Response B:\n{b}\n\n"
                "Return only the JSON."
            ),
        },
    ]


# ----- HTTP -------------------------------------------------------------


def _judge_call(cfg: JudgeConfig, messages: Sequence[Mapping[str, Any]]) -> tuple[str, float]:
    api_key = os.environ.get(cfg.api_key_env, "")
    if not api_key and "openai" in cfg.base_url:
        raise RuntimeError(
            f"judge needs an API key in env {cfg.api_key_env}. "
            f"Set it or point base_url at a local server with no auth."
        )
    body = json.dumps({
        "model": cfg.model,
        "messages": list(messages),
        "temperature": cfg.temperature,
        "max_tokens": cfg.max_tokens,
        "response_format": {"type": "json_object"},
    }).encode("utf-8")
    headers = {"content-type": "application/json"}
    if api_key:
        headers["authorization"] = f"Bearer {api_key}"
    url = cfg.base_url.rstrip("/") + "/chat/completions"
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=cfg.request_timeout_s) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"judge {cfg.model} {url} -> HTTP {exc.code}: {body_text[:300]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"judge {cfg.model} {url} -> connection error: {exc}") from exc
    text = payload["choices"][0]["message"]["content"]
    usage = payload.get("usage", {}) or {}
    cost = _estimate_cost_usd(cfg.model, usage)
    logger.debug("[judge] %s in_t=%s out_t=%s cost=$%.4f dt=%.2fs",
                 cfg.model, usage.get("prompt_tokens"), usage.get("completion_tokens"),
                 cost, time.monotonic() - t0)
    return text, cost


# Public-pricing snapshot used as a CONSERVATIVE upper-bound. The exact
# numbers drift; this is a budget guard, not a billing system.
_PRICE_USD_PER_1K_TOKENS: dict[str, tuple[float, float]] = {
    "gpt-4o-mini": (0.00015, 0.0006),
    "gpt-4o": (0.0025, 0.01),
    "gpt-4.1-mini": (0.00040, 0.00160),
    "claude-haiku-4-5-20251001": (0.0008, 0.004),
    "claude-sonnet-4-6": (0.003, 0.015),
    "claude-opus-4-7": (0.015, 0.075),
}


def _estimate_cost_usd(model: str, usage: Mapping[str, Any]) -> float:
    p = _PRICE_USD_PER_1K_TOKENS.get(model)
    if not p:
        return 0.0
    pin, pout = p
    pt = float(usage.get("prompt_tokens", 0))
    ct = float(usage.get("completion_tokens", 0))
    return (pt / 1000.0) * pin + (ct / 1000.0) * pout


# ----- response parsing --------------------------------------------------


_INT_SCORE_RE = re.compile(r"\b(10|[1-9])\b")


def _parse_pointwise(text: str) -> tuple[int, str]:
    try:
        obj = json.loads(text)
        if isinstance(obj, dict) and "score" in obj:
            score = int(obj["score"])
            reasoning = str(obj.get("reasoning", ""))
            return _clamp(score, 1, 10), reasoning
    except (json.JSONDecodeError, ValueError, TypeError):
        pass
    # Salvage: find first integer 1-10 in the raw text.
    m = _INT_SCORE_RE.search(text)
    if m:
        try:
            return _clamp(int(m.group(1)), 1, 10), text.strip()[:200]
        except ValueError:
            pass
    return 1, f"unparseable: {text.strip()[:200]}"


def _parse_pairwise(text: str) -> tuple[str, str]:
    try:
        obj = json.loads(text)
        if isinstance(obj, dict) and "verdict" in obj:
            v = str(obj["verdict"]).strip().upper()
            if v == "TIE":
                return "tie", str(obj.get("reasoning", ""))
            if v in ("A", "B"):
                return v, str(obj.get("reasoning", ""))
    except (json.JSONDecodeError, ValueError, TypeError):
        pass
    if re.search(r"\bA\b", text) and not re.search(r"\bB\b", text):
        return "A", text.strip()[:200]
    if re.search(r"\bB\b", text) and not re.search(r"\bA\b", text):
        return "B", text.strip()[:200]
    return "tie", f"unparseable: {text.strip()[:200]}"


def _clamp(n: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, n))


# ----- public entry points -----------------------------------------------


def judge_pointwise(
    items: Iterable[Mapping[str, str]],
    cfg: JudgeConfig,
) -> JudgeResult:
    """
    Score each {prompt, response} item on 1-10.

    items: iterable of dicts with keys "prompt" and "response".

    Returns JudgeResult with `judge_score` in [0,1] = mean(score)/10.
    """
    rubric = cfg.rubric or DEFAULT_POINTWISE_RUBRIC
    out: list[PointwiseScore] = []
    total_cost = 0.0
    n_req = 0
    for it in items:
        if n_req >= cfg.max_requests:
            logger.warning("[judge] hit max_requests=%d, stopping", cfg.max_requests)
            break
        text, cost = _judge_call(cfg, _pointwise_messages(it["prompt"], it["response"], rubric))
        score, reasoning = _parse_pointwise(text)
        out.append(PointwiseScore(score=score, reasoning=reasoning, raw=text, cost_usd=cost))
        total_cost += cost
        n_req += 1

    if not out:
        return JudgeResult(mode=JudgeMode.POINTWISE, items=0, total_cost_usd=0.0, judge_score=0.0)
    mean = sum(p.score for p in out) / len(out)
    return JudgeResult(
        mode=JudgeMode.POINTWISE,
        pointwise=tuple(out),
        items=len(out),
        total_cost_usd=round(total_cost, 6),
        judge_score=round(mean / 10.0, 4),
    )


def judge_pairwise(
    items: Iterable[Mapping[str, str]],
    cfg: JudgeConfig,
) -> JudgeResult:
    """
    Compare two responses per prompt. items keys: prompt, a, b.

    With cfg.bias_correct_pairwise=True (default), each pair is judged in
    both orders (A,B) and (B,A); the verdict is averaged.

    Returns JudgeResult with `judge_score` in [0,1] = A-win rate.
    """
    rubric = cfg.rubric or DEFAULT_PAIRWISE_RUBRIC
    verdicts: list[PairwiseScore] = []
    total_cost = 0.0
    a_wins = 0
    b_wins = 0
    ties = 0
    n_req = 0
    for it in items:
        if n_req >= cfg.max_requests:
            logger.warning("[judge] hit max_requests=%d, stopping", cfg.max_requests)
            break
        text, cost = _judge_call(cfg, _pairwise_messages(it["prompt"], it["a"], it["b"], rubric))
        v1, r1 = _parse_pairwise(text)
        verdicts.append(PairwiseScore(verdict=v1, reasoning=r1, raw=text, cost_usd=cost))
        total_cost += cost
        n_req += 1

        if cfg.bias_correct_pairwise:
            if n_req >= cfg.max_requests:
                break
            text2, cost2 = _judge_call(cfg, _pairwise_messages(it["prompt"], it["b"], it["a"], rubric))
            v2, r2 = _parse_pairwise(text2)
            v2_canonical = {"A": "B", "B": "A", "tie": "tie"}[v2]
            verdicts.append(PairwiseScore(verdict=v2_canonical, reasoning=r2, raw=text2, cost_usd=cost2))
            total_cost += cost2
            n_req += 1

            both = (v1, v2_canonical)
            if both == ("A", "A"):
                a_wins += 1
            elif both == ("B", "B"):
                b_wins += 1
            else:
                ties += 1
        else:
            if v1 == "A":
                a_wins += 1
            elif v1 == "B":
                b_wins += 1
            else:
                ties += 1

    total = a_wins + b_wins + ties
    if total == 0:
        return JudgeResult(mode=JudgeMode.PAIRWISE, items=0, total_cost_usd=0.0, judge_score=0.0)
    return JudgeResult(
        mode=JudgeMode.PAIRWISE,
        pairwise=tuple(verdicts),
        items=total,
        total_cost_usd=round(total_cost, 6),
        judge_score=round(a_wins / total, 4),
        tie_rate=round(ties / total, 4),
        a_wins=a_wins,
        b_wins=b_wins,
        ties=ties,
    )


def judge(
    items: Iterable[Mapping[str, str]],
    cfg: JudgeConfig,
) -> JudgeResult:
    """Dispatch on cfg.mode."""
    if cfg.mode is JudgeMode.POINTWISE:
        return judge_pointwise(items, cfg)
    if cfg.mode is JudgeMode.PAIRWISE:
        return judge_pairwise(items, cfg)
    raise ValueError(f"unhandled judge mode {cfg.mode}")


def receipt_record(result: JudgeResult, *, judge_model: str) -> dict:
    """Build a small dict for receipt provenance. Stable key shape."""
    return {
        "type": "judge",
        "mode": result.mode.value,
        "judge_model": judge_model,
        "items": result.items,
        "judge_score": result.judge_score,
        "tie_rate": result.tie_rate,
        "cost_usd": result.total_cost_usd,
    }


__all__ = [
    "JudgeMode",
    "JudgeConfig",
    "JudgeResult",
    "PointwiseScore",
    "PairwiseScore",
    "judge",
    "judge_pointwise",
    "judge_pairwise",
    "receipt_record",
    "DEFAULT_POINTWISE_RUBRIC",
    "DEFAULT_PAIRWISE_RUBRIC",
]
