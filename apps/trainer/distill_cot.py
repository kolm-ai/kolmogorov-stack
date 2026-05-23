"""
apps/trainer/distill_cot.py

W713-2 — Chain-of-thought training-data formatter.

When the teacher in a capture row is a reasoning model (Claude with thinking
blocks, OpenAI o1 with reasoning_tokens, DeepSeek-R1 with <think>...</think>),
src/capture.js extractReasoningTrace() stamps a `reasoning_trace` field on the
capture. This module turns that captured trace into training-data text so the
student learns to reproduce the reasoning, not just the answer.

We DO NOT edit distill.py — this is the additive sibling module that the W713
distill flag wires into the training pipeline. distill.py is the original
response-only path and remains the default for short-context targets and when
--no-cot is passed.

The byte-exact contract:

  inline_think_tags mode for a capture with reasoning text R and response A:

      f"<think>{R}</think>{A}"

  This MUST match the output of src/chat-templates.js wrapAssistantWithThinking
  for the same inputs — the JS-side runtime and the Python-side trainer agree
  on one envelope so a .kolm artifact baked here renders correctly when the
  runtime applies the kolm-think template.

Honesty contracts:

  - capture.reasoning_trace is None → returns response_text alone (backward
    compatible: legacy captures without chain-of-thought become legacy training
    rows).
  - reasoning_trace exists but is empty/malformed → log a warning and format
    as if reasoning_trace was None. Never throw — a malformed row should not
    crash a 50k-row distill run.

KOLM_THINK_TEMPLATE_VERSION here MUST agree byte-for-byte with the JS constant
in src/chat-templates.js so version stamping on either side identifies the same
template generation.
"""

from __future__ import annotations

import logging
import warnings
from typing import Any, Dict, Optional

# Version constant — MUST byte-match src/chat-templates.js KOLM_THINK_TEMPLATE_VERSION.
KOLM_THINK_TEMPLATE_VERSION = "w713-v1"

# Accepted modes. response_only is the legacy distill.py behavior; surface here
# as a sentinel so callers (cli/kolm.js distill flag) can pass it explicitly
# rather than calling distill.py for that arm.
MODE_INLINE_THINK_TAGS = "inline_think_tags"
MODE_SEPARATE_MESSAGES = "separate_messages"
MODE_RESPONSE_ONLY = "response_only"

_ACCEPTED_MODES = frozenset({
    MODE_INLINE_THINK_TAGS,
    MODE_SEPARATE_MESSAGES,
    MODE_RESPONSE_ONLY,
})

_log = logging.getLogger(__name__)


def _extract_response_text(capture: Dict[str, Any]) -> str:
    """Pull the model output text from a capture row. Defensive — accepts
    several field names because different capture sources name it differently
    (router.js writes 'response', extract.js may write 'output', etc.)."""
    if not isinstance(capture, dict):
        return ""
    for key in ("response", "output", "completion", "text"):
        v = capture.get(key)
        if isinstance(v, str):
            return v
        if v is not None:
            # Defensive: stringify dict/list responses without throwing.
            try:
                import json
                return json.dumps(v, ensure_ascii=False)
            except Exception:
                return str(v)
    return ""


def _extract_reasoning_text(reasoning_trace: Any) -> Optional[str]:
    """Pull a single reasoning text string out of the envelope shape that
    src/capture.js extractReasoningTrace() emits. Returns None if no reasoning
    text is present (caller treats this same as reasoning_trace==None).

    Envelope shape (kept in sync with src/capture.js):
        {
          provider: 'anthropic'|'openai'|'generic',
          blocks?: [{type: 'thinking', text: '...'}, {type: 'text', text: '...'}],
          reasoning_text_if_present?: str,  # OpenAI o-series
          ...
        }
    """
    if not isinstance(reasoning_trace, dict):
        return None
    # blocks[].type=='thinking' is the canonical path (anthropic + generic).
    blocks = reasoning_trace.get("blocks")
    if isinstance(blocks, list):
        chunks = []
        for b in blocks:
            if isinstance(b, dict) and b.get("type") == "thinking":
                t = b.get("text")
                if isinstance(t, str) and t:
                    chunks.append(t)
        if chunks:
            return "".join(chunks)
    # OpenAI o-series sometimes returns reasoning text inline.
    t = reasoning_trace.get("reasoning_text_if_present")
    if isinstance(t, str) and t:
        return t
    return None


def format_capture_with_cot(
    capture: Dict[str, Any],
    mode: str = MODE_INLINE_THINK_TAGS,
) -> str:
    """Format a single capture row into a training-data string.

    Args:
        capture: a capture row dict — must carry at least 'response' (or one
            of the accepted aliases) and optionally 'reasoning_trace'.
        mode: one of:
            - 'inline_think_tags' (default): `<think>{reasoning}</think>{answer}`.
              Student learns to emit thinking before answer in one continuous
              generation. Byte-exact match to src/chat-templates.js
              wrapAssistantWithThinking().
            - 'separate_messages': multi-turn ChatML-style. The thinking is
              emitted as an assistant pre-message and the answer as the final
              assistant turn. For models that don't support inline thinking.
            - 'response_only': forced legacy path — drops reasoning even if
              present. Equivalent to mode==None plus a guarantee that no
              chain-of-thought leaks into the training string.

    Returns:
        The formatted training-data string. NEVER throws — a malformed capture
        falls back to response text alone with a logged warning.

    Honesty contract:
        - capture['reasoning_trace'] is None → returns response_text alone
          regardless of mode (backward compat).
        - reasoning_trace exists but is empty/malformed → log warning + format
          as if reasoning_trace was None.
    """
    if not isinstance(capture, dict):
        # Caller passed a None or a string — never throw, just return ''.
        return ""

    if mode not in _ACCEPTED_MODES:
        # Unknown mode → warn + fall back to inline_think_tags (the default
        # the rest of the pipeline expects).
        _log.warning(
            "format_capture_with_cot: unknown mode %r; falling back to %r",
            mode,
            MODE_INLINE_THINK_TAGS,
        )
        mode = MODE_INLINE_THINK_TAGS

    response_text = _extract_response_text(capture)

    # Mode 0: forced response-only — never look at reasoning_trace at all.
    if mode == MODE_RESPONSE_ONLY:
        return response_text

    # Backward compat: no reasoning_trace present (None) → response only.
    reasoning_trace = capture.get("reasoning_trace")
    if reasoning_trace is None:
        return response_text

    # Honest fallback: reasoning_trace exists but isn't a dict (e.g. someone
    # wrote {} or a string) — warn + treat as None.
    if not isinstance(reasoning_trace, dict):
        _log.warning(
            "format_capture_with_cot: reasoning_trace present but not a dict (%s); "
            "formatting as response_only",
            type(reasoning_trace).__name__,
        )
        return response_text

    reasoning_text = _extract_reasoning_text(reasoning_trace)
    if not reasoning_text:
        # reasoning_trace was a dict but no thinking text inside → still honest
        # fallback to response_only. This catches:
        #   - {} or {provider:'openai'} with no usage hints
        #   - blocks=[] or blocks=[{type:'text',...}] only
        #   - reasoning_tokens > 0 but no inline text (we don't fabricate)
        _log.warning(
            "format_capture_with_cot: reasoning_trace present but no thinking "
            "text extractable; formatting as response_only"
        )
        return response_text

    if mode == MODE_INLINE_THINK_TAGS:
        # Byte-exact contract with src/chat-templates.js wrapAssistantWithThinking.
        # Do NOT insert whitespace or newlines around the tags.
        return f"<think>{reasoning_text}</think>{response_text}"

    if mode == MODE_SEPARATE_MESSAGES:
        # ChatML-style: thinking as a pre-assistant message, then the answer.
        # The boundary markers match src/chat-templates.js chatml template so a
        # student trained with this mode applies cleanly to chatml chains.
        return (
            "<|im_start|>assistant\n"
            f"<think>{reasoning_text}</think>"
            "<|im_end|>\n"
            "<|im_start|>assistant\n"
            f"{response_text}<|im_end|>"
        )

    # Defensive default — should be unreachable given mode validation above.
    return response_text


def detect_cot_capture_rate(captures) -> float:
    """Return the fraction of captures that carry a non-null reasoning_trace.

    Used by the cli/kolm.js distill --from-captures path to auto-pick CoT mode:
    if >5% of captures have traces, default to inline_think_tags; otherwise
    default to response_only.

    Returns 0.0 on empty or invalid input — never raises.
    """
    if not captures:
        return 0.0
    try:
        total = 0
        with_trace = 0
        for c in captures:
            total += 1
            if isinstance(c, dict) and c.get("reasoning_trace") is not None:
                # Honest count: an explicit None doesn't count; a {} dict does
                # (we'll discover the dict is empty at format-time and warn,
                # but the capture proxy DID stamp something).
                with_trace += 1
        return with_trace / total if total > 0 else 0.0
    except Exception:
        return 0.0


__all__ = [
    "KOLM_THINK_TEMPLATE_VERSION",
    "MODE_INLINE_THINK_TAGS",
    "MODE_SEPARATE_MESSAGES",
    "MODE_RESPONSE_ONLY",
    "format_capture_with_cot",
    "detect_cot_capture_rate",
]
