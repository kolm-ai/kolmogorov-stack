"""
apps/data/synth.py

Synthetic data generation for SFT and preference packs.

When buyers don't have enough captures yet (the cold-start case), or when
the captured distribution is one-sided (only-positives, all-easy), we need
to grow the pack synthetically. This module ships three established
methods so a spec can ask for the right one without the user reading three
papers.

    Magpie          Xu et al 2024, arXiv:2406.08464
                    Prompt a base instruct model with EXACTLY the chat-template
                    BOS+user-turn-tag (e.g. <|im_start|>user\\n for Qwen,
                    <|begin_of_text|><|start_header_id|>user<|end_header_id|>\\n
                    for Llama). The model autoregresses a plausible user
                    instruction. Then re-prompt for the assistant turn. No
                    seed prompts required, generates ~clean SFT pairs.

    Evol-Instruct   Xu et al 2023, arXiv:2304.12244 (WizardLM)
                    Take a seed pack and evolve each instruction along
                    {depth, breadth} axes: add constraints, deepen reasoning,
                    broaden scope, increase concreteness. The "depth"
                    variants are the strongest signal for instruction-tuned
                    SFT.

    Self-Instruct   Wang et al 2022, arXiv:2212.10560
                    Bootstrap from N=175 seed tasks (kept in
                    docs/synth/self-instruct-seeds.json by convention).
                    For each iteration: sample 8 seeds, ask the model to
                    write a new instruction in the same style, then ask it
                    to solve. Dedup against seed pool via Rouge-L > 0.7.

    RAFT            Zhang et al 2024, arXiv:2403.10131
                    Retrieval-Augmented Fine-Tuning. For RAG distillation,
                    mix gold-context, golden+distractor, and pure-distractor
                    examples so the model learns to ignore irrelevant ctx.

Output format:
    [{"messages": [{"role":"user","content":...},
                   {"role":"assistant","content":...}], "source": "<method>"}]

The generator never logs the underlying model's API key. The output pack
carries a `synth_provenance` block so receipts and audits can show what
share of training data was synthetic.
"""

from __future__ import annotations

import dataclasses
import enum
import hashlib
import json
import logging
import math
import os
import random
import re
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Iterable, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)


class SynthMethod(str, enum.Enum):
    MAGPIE = "magpie"
    EVOL_INSTRUCT = "evol-instruct"
    SELF_INSTRUCT = "self-instruct"
    RAFT = "raft"


@dataclasses.dataclass(frozen=True)
class SynthConfig:
    method: SynthMethod
    n: int = 500                          # how many examples to produce
    base_url: str = "https://api.openai.com/v1"
    model: str = "gpt-4o-mini"
    api_key_env: str = "OPENAI_API_KEY"
    temperature: float = 0.8
    max_tokens: int = 1024
    request_timeout_s: float = 60.0
    seed: int = 42

    # Magpie-only
    chat_template: str = "auto"           # auto|qwen|llama|gemma|chatml

    # Evol-Instruct-only
    evol_axes: tuple[str, ...] = ("deepen", "concretize", "constrain", "reason", "complicate")

    # Self-Instruct-only
    seed_pool_path: Optional[str] = None

    # RAFT-only
    distractor_rate: float = 0.5
    pure_distractor_share: float = 0.2


# ----- HTTP helpers -----------------------------------------------------


def _post_chat(
    cfg: SynthConfig,
    messages: Sequence[Mapping[str, Any]],
    *,
    extra: Optional[Mapping[str, Any]] = None,
) -> str:
    api_key = os.environ.get(cfg.api_key_env, "")
    body: dict[str, Any] = {
        "model": cfg.model,
        "messages": list(messages),
        "temperature": cfg.temperature,
        "max_tokens": cfg.max_tokens,
    }
    if extra:
        body.update(extra)
    payload = json.dumps(body).encode("utf-8")
    headers = {"content-type": "application/json"}
    if api_key:
        headers["authorization"] = f"Bearer {api_key}"
    url = cfg.base_url.rstrip("/") + "/chat/completions"
    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=cfg.request_timeout_s) as resp:
            return json.loads(resp.read().decode("utf-8"))["choices"][0]["message"]["content"]
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"synth {cfg.model} -> HTTP {exc.code}: {text[:300]}") from exc


def _post_completion(
    cfg: SynthConfig,
    prompt: str,
    *,
    stop: Optional[Sequence[str]] = None,
) -> str:
    """Raw /v1/completions for Magpie-style autoregress against a chat-template prefix."""
    api_key = os.environ.get(cfg.api_key_env, "")
    body: dict[str, Any] = {
        "model": cfg.model,
        "prompt": prompt,
        "temperature": cfg.temperature,
        "max_tokens": cfg.max_tokens,
    }
    if stop:
        body["stop"] = list(stop)
    headers = {"content-type": "application/json"}
    if api_key:
        headers["authorization"] = f"Bearer {api_key}"
    url = cfg.base_url.rstrip("/") + "/completions"
    payload = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=cfg.request_timeout_s) as resp:
        return json.loads(resp.read().decode("utf-8"))["choices"][0]["text"]


# ----- chat-template prefixes for Magpie --------------------------------


CHAT_TEMPLATES: dict[str, dict[str, str]] = {
    "qwen": {
        "user_prefix": "<|im_start|>user\n",
        "user_stop": "<|im_end|>",
        "assistant_prefix": "<|im_start|>assistant\n",
        "assistant_stop": "<|im_end|>",
    },
    "llama": {
        "user_prefix": "<|begin_of_text|><|start_header_id|>user<|end_header_id|>\n\n",
        "user_stop": "<|eot_id|>",
        "assistant_prefix": "<|start_header_id|>assistant<|end_header_id|>\n\n",
        "assistant_stop": "<|eot_id|>",
    },
    "gemma": {
        "user_prefix": "<start_of_turn>user\n",
        "user_stop": "<end_of_turn>",
        "assistant_prefix": "<start_of_turn>model\n",
        "assistant_stop": "<end_of_turn>",
    },
    "chatml": {
        "user_prefix": "<|im_start|>user\n",
        "user_stop": "<|im_end|>",
        "assistant_prefix": "<|im_start|>assistant\n",
        "assistant_stop": "<|im_end|>",
    },
}


def _auto_template(model: str) -> str:
    m = model.lower()
    if "qwen" in m:
        return "qwen"
    if "llama" in m or "meta-llama" in m:
        return "llama"
    if "gemma" in m:
        return "gemma"
    return "chatml"


def _template_for(cfg: SynthConfig) -> dict[str, str]:
    name = cfg.chat_template
    if name == "auto":
        name = _auto_template(cfg.model)
    return CHAT_TEMPLATES.get(name) or CHAT_TEMPLATES["chatml"]


# ----- Magpie -----------------------------------------------------------


def magpie(cfg: SynthConfig) -> list[dict]:
    """
    Generate {user, assistant} SFT pairs by exploiting the chat-template prefix.
    Requires a /v1/completions endpoint on a *base or instruct* model
    (vLLM-served local model, or a self-hosted vLLM endpoint).
    """
    tmpl = _template_for(cfg)
    rng = random.Random(cfg.seed)
    out: list[dict] = []
    target = cfg.n
    while len(out) < target:
        # Step 1: prefix the user turn header and let the model write the user turn.
        prefix = tmpl["user_prefix"]
        user_text = _post_completion(cfg, prefix, stop=[tmpl["user_stop"]])
        user_text = (user_text or "").strip()
        if len(user_text) < 8 or not _looks_like_instruction(user_text):
            continue
        # Step 2: close the user turn and let the model answer.
        full = (
            tmpl["user_prefix"] + user_text + tmpl["user_stop"]
            + tmpl["assistant_prefix"]
        )
        assistant_text = _post_completion(cfg, full, stop=[tmpl["assistant_stop"]])
        assistant_text = (assistant_text or "").strip()
        if len(assistant_text) < 8:
            continue
        out.append({
            "messages": [
                {"role": "user", "content": user_text},
                {"role": "assistant", "content": assistant_text},
            ],
            "source": SynthMethod.MAGPIE.value,
            "hash": _hash_pair(user_text, assistant_text),
        })
        rng.random()  # advance the rng so the seed is deterministic
    return out


_INSTRUCTION_HINT_RE = re.compile(r"[?.]|^(write|explain|how|what|when|where|why|build|create|generate|summarize|translate|list)\b", re.I)


def _looks_like_instruction(text: str) -> bool:
    return bool(_INSTRUCTION_HINT_RE.search(text))


# ----- Evol-Instruct ----------------------------------------------------


_EVOL_INSTRUCTIONS = {
    "deepen": "Rewrite the instruction to require deeper reasoning, more steps, or harder analysis.",
    "concretize": "Rewrite the instruction with more concrete, specific entities (real names, specific numbers).",
    "constrain": "Add one new constraint that the answer must satisfy (length cap, format, must include a citation).",
    "reason": "Convert the instruction so the answer must include an explanation, not just a final value.",
    "complicate": "Rewrite the instruction so a beginner would find it hard, while still being well-defined.",
}


def evol_instruct(cfg: SynthConfig, seed_pack: Sequence[Mapping[str, Any]]) -> list[dict]:
    """
    Evolve a seed pack of {prompt, response} along configured axes.
    Each seed produces len(cfg.evol_axes) variants (capped at cfg.n).
    """
    rng = random.Random(cfg.seed)
    pool: list[dict] = []
    for ex in seed_pack:
        if len(pool) >= cfg.n:
            break
        for axis in cfg.evol_axes:
            if len(pool) >= cfg.n:
                break
            ev_prompt = _evolve_one(cfg, ex.get("prompt") or ex.get("instruction") or "", axis)
            if not ev_prompt:
                continue
            ev_answer = _post_chat(cfg, [
                {"role": "system", "content": "You are a careful assistant."},
                {"role": "user", "content": ev_prompt},
            ])
            pool.append({
                "messages": [
                    {"role": "user", "content": ev_prompt},
                    {"role": "assistant", "content": ev_answer},
                ],
                "source": f"{SynthMethod.EVOL_INSTRUCT.value}:{axis}",
                "hash": _hash_pair(ev_prompt, ev_answer),
            })
        rng.random()
    return pool


def _evolve_one(cfg: SynthConfig, base: str, axis: str) -> str:
    rule = _EVOL_INSTRUCTIONS.get(axis, _EVOL_INSTRUCTIONS["deepen"])
    msg = [
        {"role": "system", "content": "You are an instruction-evolver. Return only the new instruction."},
        {"role": "user", "content": f"{rule}\n\nOriginal instruction:\n{base}\n\nRewritten:"},
    ]
    return _post_chat(cfg, msg).strip()


# ----- Self-Instruct ----------------------------------------------------


def self_instruct(cfg: SynthConfig) -> list[dict]:
    """
    Bootstrap N seed tasks into N+k synthetic pairs by repeatedly prompting
    the model with sampled seeds and asking it to write a new task + solve it.
    """
    seeds = _load_seeds(cfg.seed_pool_path)
    if len(seeds) < 8:
        raise RuntimeError(
            f"self-instruct needs >=8 seed tasks in seed_pool_path; got {len(seeds)}. "
            "Pass cfg.seed_pool_path or generate a starter pool via the docs at "
            "docs/synth/self-instruct-seeds.json"
        )
    rng = random.Random(cfg.seed)
    out: list[dict] = []
    pool: list[str] = [s["prompt"] for s in seeds]
    while len(out) < cfg.n:
        examples = rng.sample(pool, k=min(8, len(pool)))
        new_task = _ask_for_new_task(cfg, examples)
        if not new_task or _is_dup(new_task, pool):
            continue
        ans = _post_chat(cfg, [
            {"role": "system", "content": "You are a careful, concise assistant."},
            {"role": "user", "content": new_task},
        ])
        pool.append(new_task)
        out.append({
            "messages": [
                {"role": "user", "content": new_task},
                {"role": "assistant", "content": ans},
            ],
            "source": SynthMethod.SELF_INSTRUCT.value,
            "hash": _hash_pair(new_task, ans),
        })
    return out


def _ask_for_new_task(cfg: SynthConfig, examples: Sequence[str]) -> str:
    body = "\n\n".join(f"- {e}" for e in examples)
    msg = [
        {"role": "system", "content": "You write new short tasks for instruction tuning. Return only the new task, no preamble."},
        {"role": "user", "content": f"Here are example tasks:\n{body}\n\nWrite ONE new task in the same style and difficulty, but on a different topic:"},
    ]
    return _post_chat(cfg, msg).strip()


def _is_dup(candidate: str, pool: Sequence[str]) -> bool:
    """Cheap Rouge-L proxy: token-overlap >0.6 is treated as a dup."""
    a = set(_tokenize(candidate))
    for p in pool[-200:]:
        b = set(_tokenize(p))
        if not a or not b:
            continue
        overlap = len(a & b) / max(len(a), len(b))
        if overlap > 0.6:
            return True
    return False


def _tokenize(s: str) -> list[str]:
    return [t for t in re.split(r"\W+", s.lower()) if len(t) > 2]


def _load_seeds(path: Optional[str]) -> list[dict]:
    if not path:
        return []
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


# ----- RAFT (Retrieval-Augmented Fine-Tuning) ---------------------------


def raft(cfg: SynthConfig, qa_pack: Sequence[Mapping[str, Any]], docs: Sequence[str]) -> list[dict]:
    """
    Build a RAFT pack from {question, gold_doc, answer} triples and a
    background doc pool. Output mixes:
      - gold-only         (question + gold + answer)
      - gold+distractor   (question + gold + 1 distractor + answer)
      - pure-distractor   (question + only distractors + "I don't know")
    """
    rng = random.Random(cfg.seed)
    out: list[dict] = []
    for ex in qa_pack:
        if len(out) >= cfg.n:
            break
        gold = str(ex.get("gold_doc") or "")
        q = str(ex.get("question") or "")
        a = str(ex.get("answer") or "")
        if not (q and a and gold):
            continue
        distractor = rng.choice(docs) if docs else ""
        mode = rng.random()
        if mode < cfg.pure_distractor_share:
            ctx = distractor
            target = "I don't know based on the provided context."
        elif mode < cfg.pure_distractor_share + cfg.distractor_rate:
            ctx = f"{gold}\n\n---\n\n{distractor}" if distractor else gold
            target = a
        else:
            ctx = gold
            target = a
        prompt = f"Context:\n{ctx}\n\nQuestion: {q}\n\nAnswer using only the context."
        out.append({
            "messages": [
                {"role": "user", "content": prompt},
                {"role": "assistant", "content": target},
            ],
            "source": SynthMethod.RAFT.value,
            "hash": _hash_pair(prompt, target),
        })
    return out


# ----- dispatch + utilities --------------------------------------------


def generate(cfg: SynthConfig, *, seeds: Optional[Sequence[Mapping[str, Any]]] = None,
             docs: Optional[Sequence[str]] = None) -> list[dict]:
    if cfg.method is SynthMethod.MAGPIE:
        return magpie(cfg)
    if cfg.method is SynthMethod.EVOL_INSTRUCT:
        if not seeds:
            raise ValueError("evol-instruct needs a seed pack via seeds= argument")
        return evol_instruct(cfg, seeds)
    if cfg.method is SynthMethod.SELF_INSTRUCT:
        return self_instruct(cfg)
    if cfg.method is SynthMethod.RAFT:
        if not seeds:
            raise ValueError("raft needs seeds (qa_pack) and docs")
        return raft(cfg, seeds, docs or [])
    raise ValueError(f"unhandled synth method {cfg.method}")


def _hash_pair(a: str, b: str) -> str:
    h = hashlib.sha256()
    h.update(a.encode("utf-8", errors="replace"))
    h.update(b"\x1e")
    h.update(b.encode("utf-8", errors="replace"))
    return h.hexdigest()[:16]


def receipt_block(pack: Sequence[Mapping[str, Any]], cfg: SynthConfig) -> dict:
    """Synth provenance for the artifact receipt."""
    sources: dict[str, int] = {}
    for ex in pack:
        s = ex.get("source", "unknown")
        sources[s] = sources.get(s, 0) + 1
    return {
        "type": "synth",
        "method": cfg.method.value,
        "model": cfg.model,
        "items": len(pack),
        "by_source": sources,
        "seed": cfg.seed,
    }


__all__ = [
    "SynthMethod",
    "SynthConfig",
    "generate",
    "magpie",
    "evol_instruct",
    "self_instruct",
    "raft",
    "receipt_block",
]
