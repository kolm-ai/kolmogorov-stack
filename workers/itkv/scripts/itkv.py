#!/usr/bin/env python3
"""
W722 - ITKV tier-selector stub (Python side).

This script is a VERBATIM PORT of src/itkv-profile.js classifyToken. The
W722 test suite asserts byte-identical outputs between the two
implementations on the same token inputs.

If you must diverge from src/itkv-profile.js, document the reason in the
header of BOTH files. Otherwise the JS/Python parity test will fail and
the orchestrator will reject the wave.

This is a stub. Runtime KV cache tier dispatch is a future wave - the real
implementation would plug into vLLM PagedAttention / SGLang radix cache.

Honesty contract: no heavy ML deps (just argparse + json + sys). Malformed
input returns exit 64 + structured JSON to stderr.

CLI:
    python3 itkv.py --tokens <tokens.jsonl> --profile <profile.json> \\
                    --output <classified.jsonl>

Token JSONL row schema (one JSON object per line):
    {
        "position": int,                       # required
        "role": str,                           # optional ('boilerplate', ...)
        "recent_window_start": int,            # optional
        "sink_anchor": int,                    # optional (default 4)
        "is_policy_span": bool,                # optional
        "is_schema_span": bool,                # optional
        "is_retrieved_evidence": bool,         # optional
        "citation_confidence": float,          # optional (only meaningful when retrieved)
        "is_repeated_prefix": bool             # optional
    }

Classified JSONL row schema (one JSON object per line):
    {
        "position": int,
        "class": "<one of TOKEN_CLASSES>",
        "precision_tier": "<one of PRECISION_TIERS>"
    }

Exit codes:
    0   ok; classified output written
    3   no python runtime (this script never returns 3 -- the Node shell does)
    64  malformed input (sysexits.h EX_USAGE convention)
"""

import argparse
import hashlib
import json
import os
import sys


# ---------------------------------------------------------------------------
# Mirror of the constants in src/itkv-profile.js. Keep in lockstep!
# ---------------------------------------------------------------------------

ITKV_VERSION = "w722-v1"

TOKEN_CLASSES = (
    "sink",
    "policy",
    "schema",
    "retrieved_evidence",
    "conversation_recent",
    "boilerplate",
    "irrelevant_span",
)

PRECISION_TIERS = (
    "bf16",
    "fp8",
    "int8",
    "int4",
    "offload",
)

DEFAULT_PRECISION_BY_CLASS = {
    "sink": "bf16",
    "policy": "fp8",
    "schema": "int8",
    "retrieved_evidence": "int8",
    "conversation_recent": "bf16",
    "boilerplate": "int4",
    "irrelevant_span": "offload",
}

DEFAULT_SINK_ANCHOR = 4
RETRIEVED_TIER_HIGH = 0.8
RETRIEVED_TIER_MID = 0.5


def path_meta(file_path):
    raw = str(file_path or "")
    return {
        "path_basename": os.path.basename(raw),
        "path_sha256": hashlib.sha256(raw.encode("utf-8")).hexdigest(),
    }


def emit_error(code, **extra):
    sys.stderr.write(json.dumps({"ok": False, "error": code, **extra}) + "\n")


def is_integer(x):
    """JS-compatible integer check (Number.isInteger semantics)."""
    return isinstance(x, int) and not isinstance(x, bool)


def is_finite_number(x):
    """JS-compatible Number.isFinite semantics."""
    if isinstance(x, bool):
        return False
    if isinstance(x, (int, float)):
        try:
            return not (x != x) and x not in (float("inf"), float("-inf"))
        except TypeError:
            return False
    return False


def classify_token(token):
    """VERBATIM port of src/itkv-profile.js classifyToken.

    Returns either a string class OR a dict {"class", "precision_tier"} when
    the class itself overrides the default precision (currently only
    retrieved_evidence whose tier depends on citation_confidence).

    Fallthrough order MUST match the JS implementation:
        1. position < sink_anchor                       -> sink
        2. is_policy_span                               -> policy
        3. is_schema_span                               -> schema
        4. is_retrieved_evidence                        -> retrieved_evidence
        5. position >= recent_window_start              -> conversation_recent
        6. role == 'boilerplate' OR is_repeated_prefix  -> boilerplate
        7. otherwise                                    -> irrelevant_span
    """
    if not isinstance(token, dict):
        raise TypeError("classify_token requires a dict")

    position = token["position"] if is_integer(token.get("position")) else -1
    sink_anchor = (
        token["sink_anchor"] if is_integer(token.get("sink_anchor")) else DEFAULT_SINK_ANCHOR
    )
    # JS uses Number.POSITIVE_INFINITY as the default; in Python we use a
    # huge number with the same effect (no token position will exceed it).
    recent_start = (
        token["recent_window_start"]
        if is_integer(token.get("recent_window_start"))
        else float("inf")
    )

    # 1. sink
    if position >= 0 and position < sink_anchor:
        return "sink"

    # 2. policy
    if token.get("is_policy_span") is True:
        return "policy"

    # 3. schema
    if token.get("is_schema_span") is True:
        return "schema"

    # 4. retrieved_evidence -- returns dict
    if token.get("is_retrieved_evidence") is True:
        conf = token.get("citation_confidence", 0.0)
        if not is_finite_number(conf):
            conf = 0.0
        if conf > RETRIEVED_TIER_HIGH:
            tier = "int8"
        elif conf > RETRIEVED_TIER_MID:
            tier = "int4"
        else:
            tier = "offload"
        return {"class": "retrieved_evidence", "precision_tier": tier}

    # 5. conversation_recent
    if position >= 0 and position >= recent_start:
        return "conversation_recent"

    # 6. boilerplate
    if token.get("role") == "boilerplate" or token.get("is_repeated_prefix") is True:
        return "boilerplate"

    # 7. fallthrough
    return "irrelevant_span"


def precision_tier_for(class_result, precision_by_class):
    """Resolve precision tier given a classify_token result + an optional
    precision_by_class override map.
    """
    mapping = precision_by_class if precision_by_class else DEFAULT_PRECISION_BY_CLASS
    if isinstance(class_result, dict):
        return class_result["precision_tier"]
    return mapping.get(class_result, "offload")


def main(argv):
    parser = argparse.ArgumentParser(
        prog="kolm-itkv",
        description="W722 ITKV tier-selector stub (JS classifyToken parity port)",
    )
    parser.add_argument("--tokens", required=True, help="path to JSONL of token rows")
    parser.add_argument("--profile", default=None, help="optional ITKV profile JSON path")
    parser.add_argument("--output", required=True, help="path to write classified JSONL")
    args = parser.parse_args(argv)

    # Load optional profile (used for precision_by_class override).
    precision_by_class = None
    if args.profile:
        try:
            with open(args.profile, "r", encoding="utf-8") as fh:
                prof = json.load(fh)
            if isinstance(prof, dict) and isinstance(prof.get("precision_by_class"), dict):
                precision_by_class = prof["precision_by_class"]
        except Exception as e:
            emit_error(
                "profile_parse_failed",
                detail=str(e)[:240],
                **path_meta(args.profile),
            )
            return 64

    # Stream tokens, classify, write output.
    out_rows = []
    line_no = 0
    try:
        with open(args.tokens, "r", encoding="utf-8") as fh:
            for raw in fh:
                line_no += 1
                line = raw.strip()
                if not line:
                    continue
                try:
                    tok = json.loads(line)
                except json.JSONDecodeError as e:
                    sys.stderr.write(
                        json.dumps(
                            {
                                "ok": False,
                                "error": "malformed_token_line",
                                "line": line_no,
                                "detail": str(e),
                            }
                        )
                        + "\n"
                    )
                    return 64
                if not isinstance(tok, dict):
                    sys.stderr.write(
                        json.dumps(
                            {
                                "ok": False,
                                "error": "malformed_token_line",
                                "line": line_no,
                                "detail": "token row must be a JSON object",
                            }
                        )
                        + "\n"
                    )
                    return 64
                result = classify_token(tok)
                tier = precision_tier_for(result, precision_by_class)
                cls = result["class"] if isinstance(result, dict) else result
                pos = tok["position"] if is_integer(tok.get("position")) else -1
                out_rows.append({"position": pos, "class": cls, "precision_tier": tier})
    except FileNotFoundError as e:
        emit_error(
            "tokens_file_not_found",
            detail=e.__class__.__name__,
            **path_meta(args.tokens),
        )
        return 64
    except Exception as e:
        emit_error("io_failed", detail=e.__class__.__name__, **path_meta(args.tokens))
        return 64

    try:
        with open(args.output, "w", encoding="utf-8") as fh:
            for r in out_rows:
                fh.write(json.dumps(r, separators=(",", ":"), sort_keys=True) + "\n")
    except Exception as e:
        emit_error("output_write_failed", detail=e.__class__.__name__, **path_meta(args.output))
        return 64

    # Honest envelope on success too -- one summary JSON to stdout.
    sys.stdout.write(
        json.dumps(
            {
                "ok": True,
                "version": ITKV_VERSION,
                "tokens_in": line_no,
                "tokens_classified": len(out_rows),
                "output": args.output,
            }
        )
        + "\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
