"""
apps/runtime/constrained.py

Constrained generation: force the model to emit only strings matching a
schema, regex, EBNF grammar, or fixed-choice set. Built on Outlines and
lm-format-enforcer, both of which ship as logits processors compatible
with vLLM and transformers.

Why this matters:
  - JSON-mode without retries
  - Tool calls that always validate
  - Classifier outputs that always parse
  - Domain DSLs (SQL, code grammars, ICD-10 codes)

API:

    from apps.runtime.constrained import (
        json_schema_processor, regex_processor, choice_processor, grammar_processor
    )

    processor = json_schema_processor({
        "type": "object",
        "properties": {"diagnosis_code": {"type": "string", "pattern": "^[A-Z][0-9]{2}\\.[0-9]$"}},
        "required": ["diagnosis_code"]
    }, tokenizer=tok)
    out = model.generate(..., logits_processor=[processor])

If outlines / lm-format-enforcer are unavailable, json_mode falls back to a
post-hoc parser+retry shim that keeps the API surface uniform.
"""

from __future__ import annotations

import dataclasses
import json
import logging
import re
from typing import Any, Mapping, Sequence

logger = logging.getLogger(__name__)


@dataclasses.dataclass
class ConstraintResult:
    processor: Any | None
    backend: str
    fallback_post_hoc: bool = False


def _try_import_outlines():
    try:
        import outlines  # noqa: F401
        return __import__("outlines")
    except Exception:
        return None


def _try_import_lmfe():
    try:
        import lmformatenforcer  # noqa: F401
        return __import__("lmformatenforcer")
    except Exception:
        return None


def json_schema_processor(schema: Mapping[str, Any], *, tokenizer) -> ConstraintResult:
    """
    Build a logits processor that forces output to match `schema`.

    Backends, in priority order:
      1. Outlines (best schema coverage, fast)
      2. lm-format-enforcer (mature, slightly slower)
      3. post-hoc retry shim
    """
    outlines = _try_import_outlines()
    if outlines is not None:
        try:
            from outlines.processors import JSONLogitsProcessor
            proc = JSONLogitsProcessor(json.dumps(schema), tokenizer)
            return ConstraintResult(processor=proc, backend="outlines")
        except Exception as exc:
            logger.warning("[constrained] outlines failed (%s); trying lmfe", exc)

    lmfe = _try_import_lmfe()
    if lmfe is not None:
        try:
            from lmformatenforcer import JsonSchemaParser
            from lmformatenforcer.integrations.transformers import (
                build_transformers_prefix_allowed_tokens_fn,
            )
            parser = JsonSchemaParser(dict(schema))
            allowed_fn = build_transformers_prefix_allowed_tokens_fn(tokenizer, parser)
            return ConstraintResult(processor=allowed_fn, backend="lmformatenforcer")
        except Exception as exc:
            logger.warning("[constrained] lmformatenforcer failed (%s); using post-hoc shim", exc)

    return ConstraintResult(processor=None, backend="post-hoc", fallback_post_hoc=True)


def regex_processor(pattern: str, *, tokenizer) -> ConstraintResult:
    """Logits processor for a Python-style regex. Outlines.RegexLogitsProcessor backend."""
    outlines = _try_import_outlines()
    if outlines is not None:
        try:
            from outlines.processors import RegexLogitsProcessor
            return ConstraintResult(
                processor=RegexLogitsProcessor(pattern, tokenizer),
                backend="outlines",
            )
        except Exception as exc:
            logger.warning("[constrained] outlines regex failed (%s); using post-hoc", exc)

    return ConstraintResult(processor=None, backend="post-hoc", fallback_post_hoc=True)


def choice_processor(choices: Sequence[str], *, tokenizer) -> ConstraintResult:
    """Force output to be one of a fixed set of strings (classifier mode)."""
    if not choices:
        raise ValueError("choice_processor needs at least one choice")
    pat = "(" + "|".join(re.escape(c) for c in choices) + ")$"
    return regex_processor(pat, tokenizer=tokenizer)


def grammar_processor(grammar_ebnf: str, *, tokenizer) -> ConstraintResult:
    """Force output to match an EBNF/CFG grammar. Outlines.CFGLogitsProcessor backend."""
    outlines = _try_import_outlines()
    if outlines is not None:
        try:
            from outlines.processors import CFGLogitsProcessor
            return ConstraintResult(
                processor=CFGLogitsProcessor(grammar_ebnf, tokenizer),
                backend="outlines",
            )
        except Exception as exc:
            logger.warning("[constrained] outlines grammar failed (%s); using post-hoc", exc)

    return ConstraintResult(processor=None, backend="post-hoc", fallback_post_hoc=True)


# ---- Post-hoc fallback ---------------------------------------------------

def validate_and_retry_json(text: str, schema: Mapping[str, Any]) -> tuple[bool, dict | None, str]:
    """
    Validate `text` against `schema`. Returns (ok, parsed, error_message).
    """
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        return (False, None, f"not valid JSON: {exc}")

    try:
        import jsonschema
        jsonschema.validate(instance=parsed, schema=dict(schema))
        return (True, parsed, "")
    except ImportError:
        return _minimal_validate(parsed, schema)
    except Exception as exc:
        return (False, parsed, str(exc))


def _minimal_validate(obj: Any, schema: Mapping[str, Any]) -> tuple[bool, Any, str]:
    """Tiny subset of JSON-schema validation."""
    typ = schema.get("type")
    if typ == "object":
        if not isinstance(obj, dict):
            return (False, obj, "expected object")
        for r in schema.get("required", []):
            if r not in obj:
                return (False, obj, f"missing required field '{r}'")
        for k, sub in schema.get("properties", {}).items():
            if k in obj:
                ok, _, err = _minimal_validate(obj[k], sub)
                if not ok:
                    return (False, obj, f"field '{k}': {err}")
        return (True, obj, "")
    if typ == "array":
        if not isinstance(obj, list):
            return (False, obj, "expected array")
        if "items" in schema:
            for i, v in enumerate(obj):
                ok, _, err = _minimal_validate(v, schema["items"])
                if not ok:
                    return (False, obj, f"item[{i}]: {err}")
        return (True, obj, "")
    if typ == "string":
        if not isinstance(obj, str):
            return (False, obj, "expected string")
        if "pattern" in schema:
            if not re.match(schema["pattern"], obj):
                return (False, obj, f"does not match pattern '{schema['pattern']}'")
        return (True, obj, "")
    if typ == "number":
        if not isinstance(obj, (int, float)) or isinstance(obj, bool):
            return (False, obj, "expected number")
        return (True, obj, "")
    if typ == "integer":
        if not isinstance(obj, int) or isinstance(obj, bool):
            return (False, obj, "expected integer")
        return (True, obj, "")
    if typ == "boolean":
        if not isinstance(obj, bool):
            return (False, obj, "expected boolean")
        return (True, obj, "")
    if typ == "null":
        if obj is not None:
            return (False, obj, "expected null")
        return (True, obj, "")
    return (True, obj, "")


def post_hoc_retry_json(
    *,
    generate_fn,
    prompt: str,
    schema: Mapping[str, Any],
    max_retries: int = 3,
) -> tuple[bool, dict | None, str]:
    """Retry loop when no logits-processor backend is available."""
    err = ""
    last_text = ""
    for attempt in range(max_retries):
        text = generate_fn(
            prompt if attempt == 0
            else f"{prompt}\n\nLast attempt failed: {err}\nReturn ONLY valid JSON matching the schema."
        )
        last_text = text
        ok, parsed, err = validate_and_retry_json(text, schema)
        if ok:
            return (True, parsed, "")
    return (False, None, f"failed after {max_retries} retries; last error: {err}; last text: {last_text[:200]}")


__all__ = [
    "ConstraintResult",
    "json_schema_processor",
    "regex_processor",
    "choice_processor",
    "grammar_processor",
    "validate_and_retry_json",
    "post_hoc_retry_json",
]
