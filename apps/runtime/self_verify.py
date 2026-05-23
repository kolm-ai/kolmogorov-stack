"""
apps/runtime/self_verify.py

W728-2: Self-verification with capped retries (chain-of-verification).

The model evaluates its own output against the prompt by answering a
verification question: "Is this answer correct AND complete for the
prompt?". On a NO (or a clearly-low confidence score), we regenerate with
the verification feedback fed back into the prompt, up to ``max_retries``
rounds. If we still fail after the cap, we return the final candidate
with ``verified=False`` — explicitly honest, never a silent pass.

This is the inference-time analogue of self-consistency: rather than
voting across N samples (apps/runtime/ttc.py:self_consistency), we burn
sequential compute on revising a single trajectory. The two compose
inside apps/runtime/inference_time_scaling.py (best_of_n picks the
candidate; self_verify gates whether that candidate is shipped or
regenerated).

Surface (load-bearing for tests/wave728-its.test.js):

    def self_verify(prompt, candidate, model_fn=None, max_retries=3) -> dict

Return shape:

    {
        "final_output":    str,
        "verified":        bool,
        "rounds":          int,
        "feedback_trail":  list[dict],
    }

Each ``feedback_trail`` row is:

    {
        "round":         int,     # 0-indexed
        "candidate":     str,     # what we tried to verify on this round
        "verdict":       bool,    # True = verifier accepted
        "feedback":      str,     # verifier's free-text critique
        "verifier_raw":  Any,     # the raw model_fn output for debug
    }
"""

from __future__ import annotations

from typing import Any, Callable, Optional


_VERIFY_PROMPT_TEMPLATE = (
    "You are a strict verifier. The user asked:\n\n"
    "{prompt}\n\n"
    "The candidate answer is:\n\n"
    "{candidate}\n\n"
    "Is the candidate CORRECT and COMPLETE for the prompt?\n"
    "Reply on a single line:\n"
    "  YES <one-sentence reason>\n"
    "or\n"
    "  NO <one-sentence critique pointing at what to fix>\n"
)


_REVISE_PROMPT_TEMPLATE = (
    "Original prompt:\n\n"
    "{prompt}\n\n"
    "Previous candidate (rejected by verifier):\n\n"
    "{candidate}\n\n"
    "Verifier's critique:\n\n"
    "{feedback}\n\n"
    "Produce a revised answer that addresses the critique. Reply with the answer only."
)


def _default_model_fn(prompt: str) -> str:
    """
    Honest no-op model. Always returns a "YES looks fine" verdict so a
    test that forgets to inject a verifier gets a stable shape, but the
    text marker makes the dry-run visible.
    """
    return "[no-model-fn] YES no real model was called"


def _parse_verdict(raw: Any) -> tuple[bool, str]:
    """
    Parse the verifier's reply into (verdict_bool, feedback_str).

    Accepts:
      * dict with ``{"verdict": bool, "feedback": str}`` — exact contract,
        used by tests that want to control the verifier deterministically.
      * dict with ``{"text": str}`` — fall through to string parsing on .text.
      * bare string starting with YES/NO (case-insensitive) — the natural
        shape a free-form LLM produces from _VERIFY_PROMPT_TEMPLATE.

    The "no parse" honesty path returns ``(False, "verifier_unparseable: ...")``
    so the caller can still ship the answer with verified=False rather
    than silently treating an ambiguous reply as PASS.
    """
    if isinstance(raw, dict):
        if "verdict" in raw:
            verdict = bool(raw.get("verdict"))
            feedback = str(raw.get("feedback", ""))
            return verdict, feedback
        text = str(raw.get("text", ""))
    else:
        text = str(raw)
    stripped = text.strip()
    if not stripped:
        return False, "verifier_unparseable: empty reply"
    head = stripped.split(None, 1)
    tag = head[0].strip().rstrip(":.,").upper()
    rest = head[1].strip() if len(head) > 1 else ""
    if tag == "YES":
        return True, rest
    if tag == "NO":
        return False, rest if rest else "verifier said NO without a reason"
    # Some chat models prefix verdicts with quotes or "Answer:" — be a
    # little forgiving but never invent a verdict the model didn't give.
    lowered = stripped.lower()
    if lowered.startswith(("yes,", "yes ", "yes.")):
        return True, stripped[3:].lstrip(" ,.:").strip()
    if lowered.startswith(("no,", "no ", "no.")):
        return False, stripped[2:].lstrip(" ,.:").strip()
    return False, f"verifier_unparseable: {stripped[:200]}"


def self_verify(
    prompt: str,
    candidate: str,
    model_fn: Optional[Callable[[str], Any]] = None,
    max_retries: int = 3,
) -> dict:
    """
    Run a chain-of-verification loop on ``candidate`` against ``prompt``.

    The same ``model_fn`` is used for BOTH the verification turn and the
    revision turn (since both are single-prompt operations). Tests inject
    a deterministic ``model_fn`` so the loop terminates predictably.

    Returns the shape pinned by tests/wave728-its.test.js:

        {
            "final_output":   str,
            "verified":       bool,
            "rounds":         int,
            "feedback_trail": list[dict],
        }
    """
    if not isinstance(prompt, str):
        raise TypeError(f"prompt must be a str, got {type(prompt).__name__}")
    if not isinstance(candidate, str):
        # Be lenient: coerce non-str candidates so the orchestrator can
        # hand us best_of_n's "output" field (which is always str) or a
        # raw model dict without an extra unwrap step.
        candidate = str(candidate)
    try:
        max_retries = int(max_retries)
    except (TypeError, ValueError) as exc:
        raise TypeError(f"max_retries must be int-coercible, got {max_retries!r}") from exc
    if max_retries < 0:
        raise ValueError(f"max_retries must be >= 0, got {max_retries}")

    mfn = model_fn if model_fn is not None else _default_model_fn

    feedback_trail: list[dict] = []
    current = candidate
    last_feedback = ""

    # Round 0 is the verification of the candidate we were handed. Each
    # subsequent round = one revise turn + one verify turn. We count the
    # verify turns since they decide the loop exit.
    for round_idx in range(max_retries + 1):
        v_prompt = _VERIFY_PROMPT_TEMPLATE.format(prompt=prompt, candidate=current)
        v_raw = mfn(v_prompt)
        verdict, feedback = _parse_verdict(v_raw)
        feedback_trail.append({
            "round": round_idx,
            "candidate": current,
            "verdict": verdict,
            "feedback": feedback,
            "verifier_raw": v_raw,
        })
        if verdict:
            return {
                "final_output": current,
                "verified": True,
                "rounds": round_idx,
                "feedback_trail": feedback_trail,
            }
        last_feedback = feedback
        if round_idx == max_retries:
            # We just used the last verify turn; do not revise again,
            # honest-fail with verified=False.
            break
        r_prompt = _REVISE_PROMPT_TEMPLATE.format(
            prompt=prompt, candidate=current, feedback=last_feedback,
        )
        revised_raw = mfn(r_prompt)
        if isinstance(revised_raw, dict):
            current = str(revised_raw.get("text", ""))
        else:
            current = str(revised_raw)

    # Honest fail: we exhausted retries. final_output is the last thing
    # we tried (the most recently-revised answer) so the caller can ship
    # it WITH the verified=False flag rather than getting silence.
    return {
        "final_output": current,
        "verified": False,
        "rounds": max_retries,
        "feedback_trail": feedback_trail,
    }


__all__ = ["self_verify"]
