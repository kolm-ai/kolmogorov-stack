"""
apps/trainer/instant.py

Zero-shot instant adapter — natural language task → trainable recipe in seconds.

Most kolm users have a task in their head ("redact PHI from chart notes",
"flag refund-likely tickets", "classify intent in support emails") but no
labeled examples sitting on disk. Asking them to produce 100 hand-labeled
rows is the part that kills the funnel.

This module short-circuits that. Given a plain-English task description and
an optional schema hint, it asks the teacher to:

  1. propose a verifier (regex / JSON-schema / answer-key matcher)
  2. emit N synthetic (prompt, completion) pairs that the verifier accepts
  3. round-trip each pair through the verifier; drop any that fail
  4. return a recipe scaffold compatible with apps/trainer/trainer_real.py

The output is a normal recipe + dataset that flows into the existing
SFT / LoRA pipeline. No new training path. No new file format. The K-score
gate at compile time decides whether the artifact ships.

This is named "instant" rather than "TAID" because we do not replicate the
Sakana TAID dual-teacher / interpolated distillation procedure — what we
borrow is the philosophical claim that the corpus can be synthesized from
the task description plus a verifier, with no human gold data. Calling it
TAID would over-promise.

Surface:

    from apps.trainer.instant import (
        InstantConfig,
        synthesize_recipe,
        validate_pairs,
    )

    recipe = synthesize_recipe(
        task="redact PHI from clinical chart notes",
        n=64,
        teacher="qwen-2.5-7b",
        config=InstantConfig(),
    )
    # recipe -> {preset, examples, verifier, base_model, ...}

Notes:
  * The teacher call is pluggable. Default uses the OpenAI-compatible
    /v1/chat/completions endpoint (works against vLLM, llama.cpp server,
    Together, OpenAI, anything that speaks the chat API).
  * If no teacher is reachable, the function returns a recipe shell with
    `examples=[]` and `status="needs_teacher"` so the caller can prompt the
    user to wire one up rather than silently producing junk.
  * The verifier is plain Python — a small dict with `kind` and `params`
    that the K-score evaluator already knows how to apply.
"""

from __future__ import annotations

import dataclasses
import json
import logging
import os
import re
import time
from typing import Any, Callable, Iterable, Mapping, Optional

logger = logging.getLogger(__name__)


# ----- public types --------------------------------------------------------


@dataclasses.dataclass
class InstantConfig:
    """Knobs for the synthesis pass."""

    # how many pairs to generate before filtering
    n: int = 64

    # teacher model id (HF or vendor route); driver routes from there
    teacher: str = "qwen-2.5-7b-instruct"

    # max passes through the teacher to hit n verified pairs
    max_rounds: int = 4

    # discard rate above which we abort (corpus is too noisy to be useful)
    max_reject_rate: float = 0.6

    # base model the user wants the artifact to specialize
    base_model: str = "Qwen/Qwen2.5-3B-Instruct"

    # which preset the resulting recipe should use
    preset: str = "lora-fast"

    # K-score floor for the resulting compile
    k_threshold: float = 0.85

    # seed for reproducible synthesis
    seed: int = 42

    # extra system prompt prepended to teacher requests (style hints, domain)
    system_hint: Optional[str] = None


# ----- verifier kinds ------------------------------------------------------


_VERIFIER_KINDS = ("regex", "json_schema", "answer_key", "contains_one_of")


def _propose_verifier(task: str, schema_hint: Optional[Mapping[str, Any]]) -> dict:
    """Pick a verifier kind from the task description.

    Heuristic, not LLM-based: if the user already supplied a schema, prefer
    json_schema. If the task mentions classification ("label", "classify",
    "intent", "category"), prefer answer_key. Otherwise fall back to a
    regex sanity check that the completion is non-empty and not a refusal.
    """
    if schema_hint:
        return {"kind": "json_schema", "params": {"schema": dict(schema_hint)}}

    low = task.lower()
    if any(
        kw in low for kw in ("classify", "label", "intent", "category", "tag as")
    ):
        # answer_key without keys yet — the synth pass will fill them in
        return {"kind": "answer_key", "params": {"keys": []}}

    if "redact" in low or "remove" in low or "mask" in low:
        # output should still resemble the input, just with redactions
        return {
            "kind": "regex",
            "params": {"pattern": r"^.{1,8000}$", "max_refusal": 0.05},
        }

    return {
        "kind": "regex",
        "params": {"pattern": r"^.{1,8000}$", "max_refusal": 0.05},
    }


# ----- teacher driver ------------------------------------------------------


def _default_teacher_call(prompt: str, system: str, model: str) -> str:
    """Talk to an OpenAI-compatible /v1/chat/completions endpoint.

    Environment:
      KOLM_TEACHER_BASE   — base URL (default http://127.0.0.1:8000/v1)
      KOLM_TEACHER_KEY    — bearer token (default empty)
      KOLM_TEACHER_MODEL  — overrides `model`

    Returns empty string on any error (caller treats that as a reject).
    """
    try:
        import httpx  # type: ignore
    except Exception:
        logger.warning("httpx not available; teacher call disabled")
        return ""

    base = os.environ.get("KOLM_TEACHER_BASE", "http://127.0.0.1:8000/v1").rstrip("/")
    key = os.environ.get("KOLM_TEACHER_KEY", "")
    use_model = os.environ.get("KOLM_TEACHER_MODEL") or model

    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"

    payload = {
        "model": use_model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.7,
        "max_tokens": 1024,
    }
    try:
        with httpx.Client(timeout=60.0) as c:
            r = c.post(f"{base}/chat/completions", json=payload, headers=headers)
            r.raise_for_status()
            data = r.json()
            return (data.get("choices") or [{}])[0].get("message", {}).get(
                "content", ""
            )
    except Exception as exc:  # noqa: BLE001
        logger.info("teacher call failed: %s", exc)
        return ""


# ----- prompt scaffolds ----------------------------------------------------


_SYNTH_SYSTEM = (
    "You are generating training data for a small specialized model. "
    "Respond ONLY with a JSON array of objects, each shaped as "
    '{"prompt": "...", "completion": "..."}. '
    "No prose, no markdown, no commentary. The array must be valid JSON. "
    "Each prompt should be a realistic user turn for the task; each "
    "completion should be exactly what the specialized model should output. "
    "Vary phrasing and edge cases across rows."
)


_SYNTH_USER = """Task: {task}

Output schema for completions: {schema}

Generate {batch} rows. Realistic, diverse, free of placeholder text like "..."
or unresolved work-item markers. If the task is classification, completions must be one of the
allowed labels exactly. If the task is redaction, the completion is the
input with sensitive spans replaced by an opaque token. Return only the
JSON array."""


def _format_synth_prompt(
    task: str, schema_hint: Optional[Mapping[str, Any]], batch: int
) -> str:
    schema = json.dumps(schema_hint) if schema_hint else "free-form string"
    return _SYNTH_USER.format(task=task, schema=schema, batch=batch)


# ----- verifier loop -------------------------------------------------------


_REFUSAL_RX = re.compile(
    r"(?i)\b(i (?:can|cannot|can not|won't)|sorry,|as an ai|i'm unable)"
)


def _verify_pair(pair: Mapping[str, Any], verifier: Mapping[str, Any]) -> bool:
    """Run the verifier against a single pair. Returns True if it should be kept."""
    p = pair.get("prompt")
    c = pair.get("completion")
    if not isinstance(p, str) or not isinstance(c, str):
        return False
    if not p.strip() or not c.strip():
        return False
    if _REFUSAL_RX.search(c):
        return False

    kind = verifier.get("kind")
    params = verifier.get("params", {}) or {}

    if kind == "regex":
        pat = params.get("pattern")
        if pat and not re.match(pat, c, re.DOTALL):
            return False
        return True

    if kind == "json_schema":
        try:
            obj = json.loads(c)
        except Exception:
            return False
        schema = params.get("schema") or {}
        required = schema.get("required") or []
        if isinstance(obj, dict):
            for k in required:
                if k not in obj:
                    return False
        return True

    if kind == "answer_key":
        keys = params.get("keys") or []
        if not keys:
            # learn keys on the fly; accept whatever the teacher produced
            return True
        return c.strip() in set(keys)

    if kind == "contains_one_of":
        needles = params.get("needles") or []
        return any(n in c for n in needles)

    return True


def validate_pairs(
    pairs: Iterable[Mapping[str, Any]], verifier: Mapping[str, Any]
) -> tuple[list[dict], int]:
    """Run verifier over `pairs`, return (kept, rejected_count)."""
    kept: list[dict] = []
    rejected = 0
    for pair in pairs:
        if _verify_pair(pair, verifier):
            kept.append({"prompt": pair["prompt"], "completion": pair["completion"]})
        else:
            rejected += 1
    return kept, rejected


# ----- self-instruct dedup -------------------------------------------------


def _ngrams(text: str, n: int = 4) -> set[str]:
    toks = re.findall(r"\w+", text.lower())
    if len(toks) < n:
        return {" ".join(toks)} if toks else set()
    return {" ".join(toks[i : i + n]) for i in range(len(toks) - n + 1)}


def _too_similar(a: str, pool: list[str], threshold: float = 0.7) -> bool:
    """Cheap Rouge-L-style overlap. Drop pairs whose prompt is too close to
    something we already kept — keeps the corpus diverse."""
    if not pool:
        return False
    a_gr = _ngrams(a)
    if not a_gr:
        return False
    for b in pool:
        b_gr = _ngrams(b)
        if not b_gr:
            continue
        inter = len(a_gr & b_gr)
        union = len(a_gr | b_gr)
        if union > 0 and (inter / union) >= threshold:
            return True
    return False


# ----- main entry ----------------------------------------------------------


def synthesize_recipe(
    task: str,
    *,
    n: int = 64,
    teacher: str = "qwen-2.5-7b-instruct",
    schema_hint: Optional[Mapping[str, Any]] = None,
    config: Optional[InstantConfig] = None,
    teacher_call: Optional[Callable[[str, str, str], str]] = None,
) -> dict:
    """Generate a training-ready recipe from a plain-English task description.

    Returns a dict shaped:
        {
          "status": "ready" | "needs_teacher" | "low_quality",
          "task": str,
          "preset": str,
          "base_model": str,
          "verifier": {kind, params},
          "examples": [{prompt, completion}, ...],
          "stats": {requested, kept, rejected, rounds, elapsed_s},
          "k_threshold": float,
        }
    """
    cfg = config or InstantConfig()
    cfg.n = int(n) if n else cfg.n
    cfg.teacher = teacher or cfg.teacher
    call = teacher_call or _default_teacher_call

    verifier = _propose_verifier(task, schema_hint)
    system = _SYNTH_SYSTEM
    if cfg.system_hint:
        system = system + "\n\n" + cfg.system_hint

    kept: list[dict] = []
    rejected = 0
    rounds = 0
    started = time.time()

    while len(kept) < cfg.n and rounds < cfg.max_rounds:
        rounds += 1
        # generous batch so we have headroom for rejects
        batch = max(8, min(64, cfg.n - len(kept) + 8))
        prompt = _format_synth_prompt(task, schema_hint, batch)
        raw = call(prompt, system, cfg.teacher)
        if not raw:
            continue
        try:
            arr = json.loads(_strip_codefence(raw))
        except Exception:
            # try to recover the JSON array from a noisy completion
            arr = _extract_json_array(raw)
        if not isinstance(arr, list):
            continue

        batch_kept, batch_rejected = validate_pairs(arr, verifier)
        rejected += batch_rejected

        # diversity filter against what we already kept
        kept_prompts = [k["prompt"] for k in kept]
        for pair in batch_kept:
            if _too_similar(pair["prompt"], kept_prompts):
                rejected += 1
                continue
            kept.append(pair)
            kept_prompts.append(pair["prompt"])
            if len(kept) >= cfg.n:
                break

    elapsed = round(time.time() - started, 2)

    # if the verifier is answer_key with empty keys, infer keys from the
    # kept set so the K-score evaluator has something to check against
    if (
        verifier["kind"] == "answer_key"
        and not verifier["params"].get("keys")
        and kept
    ):
        keys = sorted({k["completion"].strip() for k in kept})
        verifier["params"]["keys"] = keys

    total_attempted = max(1, len(kept) + rejected)
    reject_rate = rejected / total_attempted

    if not kept:
        status = "needs_teacher"
    elif reject_rate > cfg.max_reject_rate:
        status = "low_quality"
    else:
        status = "ready"

    return {
        "status": status,
        "task": task,
        "preset": cfg.preset,
        "base_model": cfg.base_model,
        "verifier": verifier,
        "examples": kept,
        "stats": {
            "requested": cfg.n,
            "kept": len(kept),
            "rejected": rejected,
            "reject_rate": round(reject_rate, 3),
            "rounds": rounds,
            "elapsed_s": elapsed,
        },
        "k_threshold": cfg.k_threshold,
        "seed": cfg.seed,
    }


# ----- noisy-output recovery -----------------------------------------------


_FENCE_RX = re.compile(r"^```(?:json)?\s*([\s\S]*?)\s*```\s*$", re.M)


def _strip_codefence(text: str) -> str:
    """Some teachers wrap JSON in ```json fences. Strip them."""
    m = _FENCE_RX.match(text.strip())
    if m:
        return m.group(1)
    return text


def _extract_json_array(text: str) -> list:
    """Last-resort: find the first [ ... ] balanced block and try to parse it."""
    start = text.find("[")
    if start < 0:
        return []
    depth = 0
    for i in range(start, len(text)):
        ch = text[i]
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start : i + 1])
                except Exception:
                    return []
    return []


__all__ = [
    "InstantConfig",
    "synthesize_recipe",
    "validate_pairs",
]
