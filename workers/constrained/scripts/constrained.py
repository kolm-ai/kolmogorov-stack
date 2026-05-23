#!/usr/bin/env python3
"""
W809 — constrained decoding worker (Python side).

This script is the Python end of workers/constrained/constrained.mjs. It
wraps `outlines` OR `lm-format-enforcer` for JSON-Schema-guided sampling.
NEITHER library is bundled — the script `import`s them at runtime and emits
an honest envelope (exit 3) when neither is installed:

    {"ok": false, "error": "no_constrained_decoder",
     "hint": "pip install outlines OR lm-format-enforcer",
     "version": "w809-v1"}

This is a STUB at the model-binding layer. We do NOT load a base model here:
the actual schema-guided sampler still needs an HF transformer / vLLM / TGI
backend wired through the request's `base_model` slot. That binding is a
follow-up wave. What this stub PROVES today:

    1. The honest-envelope contract: missing dep → exit 3 + version stamp.
    2. The doctor probe: independently reports outlines + lm-format-enforcer
       presence + python version so the Node shell can render a useful hint.
    3. The request/response file contract: --input <json> --output <json>
       round-trip so the orchestrator can swap in a real decoder without
       touching the JS side.

CLI:
    constrained.py --input <request.json> --output <response.json>
    constrained.py --doctor

Request schema (request.json):
    {
        "version": "w809-v1",
        "prompt": "<text>",
        "schema_spec": {
            "kind": "json"|"xml"|"grammar"|"regex",
            "schema": <inline or {"$ref": "..."}>,
            "strict": bool,
        },
        "base_model": "<model-id or null>",
        "sampler_opts": {...passthrough...}
    }

Response schema (response.json):
    {
        "ok": true,
        "version": "w809-v1",
        "output": "<text>",
        "decoder": "outlines"|"lm_format_enforcer"|"stub",
    }

Exit codes:
    0   ok
    3   no constrained decoder library installed (honest envelope)
    4   malformed input
    5   decoder threw
    64  bad args (sysexits EX_USAGE)
"""

import argparse
import importlib
import json
import os
import sys

W809_VERSION = "w809-v1"


def _probe_library(modname):
    """Return (present:bool, version:str|None)."""
    try:
        mod = importlib.import_module(modname)
        ver = getattr(mod, "__version__", None)
        if ver is None:
            # Some libraries hide version in a sub-attribute. We only need a
            # boolean for the honest envelope; surface None vs a string.
            ver = ""
        return True, str(ver)
    except Exception:
        return False, None


def doctor():
    """Print a doctor envelope and exit 0. Never errors out."""
    outlines_ok, outlines_ver = _probe_library("outlines")
    lmfe_ok, lmfe_ver = _probe_library("lmformatenforcer")
    if not lmfe_ok:
        # Both module names are commonly used. Try the hyphenated import too.
        try:
            importlib.import_module("lm_format_enforcer")
            lmfe_ok = True
        except Exception:
            pass
    envelope = {
        "ok": True,
        "version": W809_VERSION,
        "python_version": sys.version.split()[0],
        "decoders": {
            "outlines": bool(outlines_ok),
            "lm_format_enforcer": bool(lmfe_ok),
        },
        "outlines_version": outlines_ver if outlines_ok else None,
        "lm_format_enforcer_version": lmfe_ver if lmfe_ok else None,
        "ready": bool(outlines_ok or lmfe_ok),
        "hint": None if (outlines_ok or lmfe_ok)
                else "pip install outlines OR lm-format-enforcer",
    }
    sys.stdout.write(json.dumps(envelope) + "\n")
    return 0


def _missing_decoder_envelope():
    return {
        "ok": False,
        "version": W809_VERSION,
        "error": "no_constrained_decoder",
        "hint": "pip install outlines OR lm-format-enforcer",
    }


def main(argv):
    parser = argparse.ArgumentParser(
        prog="kolm-constrained",
        description="W809 constrained-decoding worker (Python side)",
    )
    parser.add_argument("--doctor", action="store_true",
                        help="print toolchain readiness + exit 0")
    parser.add_argument("--input", required=False, default=None,
                        help="path to request JSON")
    parser.add_argument("--output", required=False, default=None,
                        help="path to response JSON")
    args = parser.parse_args(argv)

    if args.doctor:
        return doctor()

    if not args.input or not args.output:
        sys.stderr.write(json.dumps({
            "ok": False,
            "version": W809_VERSION,
            "error": "bad_args",
            "hint": "pass --input <request.json> --output <response.json>",
        }) + "\n")
        return 64

    if not os.path.exists(args.input):
        sys.stderr.write(json.dumps({
            "ok": False,
            "version": W809_VERSION,
            "error": "input_not_found",
            "input": args.input,
        }) + "\n")
        return 4

    try:
        with open(args.input, "r", encoding="utf-8") as fh:
            request = json.load(fh)
    except Exception as exc:
        sys.stderr.write(json.dumps({
            "ok": False,
            "version": W809_VERSION,
            "error": "input_parse_failed",
            "detail": str(exc),
        }) + "\n")
        return 4

    if not isinstance(request, dict) or "prompt" not in request \
            or "schema_spec" not in request:
        sys.stderr.write(json.dumps({
            "ok": False,
            "version": W809_VERSION,
            "error": "input_missing_fields",
            "hint": "request must include prompt + schema_spec",
        }) + "\n")
        return 4

    outlines_ok, _ = _probe_library("outlines")
    lmfe_ok, _ = _probe_library("lmformatenforcer")
    if not lmfe_ok:
        try:
            importlib.import_module("lm_format_enforcer")
            lmfe_ok = True
        except Exception:
            pass

    if not (outlines_ok or lmfe_ok):
        # Honest envelope: never silent passthrough.
        sys.stdout.write(json.dumps(_missing_decoder_envelope()) + "\n")
        return 3

    # ------------------------------------------------------------------
    # Decoder stub. The real model load + sampler wiring is a follow-up
    # wave; this stub proves the round-trip contract: read request, emit
    # a response.json the Node shell can ingest. A library being present
    # means we can promise the contract once the model binding lands.
    # ------------------------------------------------------------------
    decoder_name = "outlines" if outlines_ok else "lm_format_enforcer"
    schema_spec = request.get("schema_spec") or {}
    kind = schema_spec.get("kind")

    # Produce a schema-shaped placeholder output so the round-trip is at
    # least kind-consistent. A real decoder would replace this string with
    # the sampled tokens.
    if kind == "json":
        output_text = "{}"
    elif kind == "xml":
        output_text = "<root/>"
    elif kind == "regex":
        output_text = ""
    elif kind == "grammar":
        output_text = ""
    else:
        output_text = ""

    response = {
        "ok": True,
        "version": W809_VERSION,
        "decoder": decoder_name,
        "output": output_text,
        "stub": True,
        "note": ("decoder library is present; real model binding is a "
                 "follow-up wave. round-trip contract is honored."),
    }
    try:
        os.makedirs(os.path.dirname(os.path.abspath(args.output)) or ".",
                    exist_ok=True)
        with open(args.output, "w", encoding="utf-8") as fh:
            json.dump(response, fh)
    except Exception as exc:
        sys.stderr.write(json.dumps({
            "ok": False,
            "version": W809_VERSION,
            "error": "output_write_failed",
            "detail": str(exc),
        }) + "\n")
        return 5
    sys.stdout.write(json.dumps({
        "ok": True,
        "version": W809_VERSION,
        "decoder": decoder_name,
        "output_path": args.output,
    }) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
