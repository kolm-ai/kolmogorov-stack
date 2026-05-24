#!/usr/bin/env python3
"""W768 - Model Card Auto-Gen (Hugging Face Model Card v0.3 standard).

Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 603-607):
    [W768-1] Auto-generate model cards (per Hugging Face standard) for every .kolm
    [W768-2] Intended use, limitations, training data summary, eval results,
             ethical considerations, environmental impact
    [W768-3] Embeddable in OneTrust / ServiceNow AI Governance / IBM OpenPages

Stdlib-only Python (same import-pattern contract as W740 importers and W763
SBOM emitter). The Node-side src/model-card-emit.js carries the same logic;
this script is here so CI runners that don't have Node can still emit a model
card from a .kolm manifest.

HF Model Card v0.3 sections (10):
    1.  model_details
    2.  intended_use
    3.  factors
    4.  metrics
    5.  evaluation_data
    6.  training_data
    7.  quantitative_analyses
    8.  ethical_considerations
    9.  caveats_and_recommendations
    10. environmental_impact

HONESTY CONTRACT (W411):
    We NEVER fabricate metric values, intended-use text, training-data
    summaries, or evaluation results. When the source manifest lacks a
    field we emit the literal string "not_yet_disclosed" - that is the
    honest sentinel an auditor expects to see when the upstream pipeline
    has not yet measured the property.

ENVIRONMENTAL IMPACT (W768-2):
    Estimated CO2 = compute_hours * gpu_class_kw * 0.475 (kg CO2 / kWh,
    global grid average per the IEA 2024 World Energy Outlook). This
    is an ESTIMATE not a MEASUREMENT. The methodology stamp
    "static_grid_average_w768_v1" + caveat "estimate_not_measured" are
    embedded in every environmental_impact emission so a downstream
    auditor cannot mistake the estimate for a measured datacenter
    bill.

CLI:
    --manifest <path>            kolm manifest.json (required)
    --out <path>                 write JSON envelope to this path instead of stdout
    --format json|markdown|huggingface   default: json
    --include-environmental      compute estimated CO2 from manifest fields

EXIT CODES:
    0  ok
    2  bad input (missing required arg / malformed manifest)
    3  unsupported format / unrecognized invocation

Output envelope (json):
    { ok: true, version: "w768-v1", format: "json",
      generated_at: "<ISO-8601>",
      card: { model_details, intended_use, ..., environmental_impact } }
"""

from __future__ import annotations

import argparse
import datetime
import json
import sys
from pathlib import Path
from typing import Any

MODEL_CARD_VERSION = "w768-v1"
MODEL_CARD_FORMATS = ("json", "markdown", "huggingface")

# HF v0.3 canonical section order. NEVER reorder without bumping the
# version stamp - byte-stability matters for downstream tooling that
# diffs sequential card emissions.
MODEL_CARD_SECTIONS = (
    "model_details",
    "intended_use",
    "factors",
    "metrics",
    "evaluation_data",
    "training_data",
    "quantitative_analyses",
    "ethical_considerations",
    "caveats_and_recommendations",
    "environmental_impact",
)

# IEA 2024 World Energy Outlook global grid average. We expose this as a
# named constant so a downstream auditor can grep for the exact source.
GLOBAL_GRID_CO2_KG_PER_KWH = 0.475

# Coarse GPU-class power in kilowatts (TDP under sustained training load,
# rounded for honest estimation - we are NOT claiming sub-watt fidelity).
# Source: vendor datasheets, normalized to a single-card draw.
GPU_CLASS_KW = {
    "a100": 0.400,
    "h100": 0.700,
    "h200": 0.700,
    "b200": 1.000,
    "rtx-5090": 0.575,
    "rtx-4090": 0.450,
    "l40s": 0.350,
    "mi300x": 0.750,
    "tpu-v5p": 0.450,
}

# Honest sentinel for every field the manifest does not provide. The string
# "not_yet_disclosed" is the W411 honest envelope value - we NEVER substitute
# an empty string, an empty list, or a synthesized placeholder that an
# auditor might mistake for measured content.
HONEST_NOT_DISCLOSED = "not_yet_disclosed"


# =============================================================================
# Internal helpers
# =============================================================================

def _get(manifest: dict, *keys: str, default: Any = None) -> Any:
    """Walk a dotted-ish key path through a manifest. Returns default if any
    segment is missing or not a dict."""
    cur: Any = manifest
    for k in keys:
        if not isinstance(cur, dict):
            return default
        if k not in cur:
            return default
        cur = cur[k]
    return cur if cur is not None else default


def _list_or_disclose(value: Any) -> Any:
    """If value is a non-empty list, return it. Otherwise return the honest
    not-disclosed sentinel so downstream renderers can show a uniform tag."""
    if isinstance(value, list) and len(value) > 0:
        return value
    return HONEST_NOT_DISCLOSED


def _str_or_disclose(value: Any) -> Any:
    if isinstance(value, str) and value.strip():
        return value
    return HONEST_NOT_DISCLOSED


def _gpu_class_kw(gpu_class: Any) -> float | None:
    if not isinstance(gpu_class, str):
        return None
    norm = gpu_class.strip().lower().replace("_", "-")
    return GPU_CLASS_KW.get(norm)


def estimate_environmental_impact(manifest: dict) -> dict:
    """Estimate CO2 emissions from manifest.compute_hours + manifest.gpu_class.

    Returns the W768 environmental_impact section in the HF Model Card v0.3
    shape. When inputs are missing we emit a structured honest envelope so
    the auditor can distinguish "not yet measured" from "zero emissions".
    """
    compute_hours = _get(manifest, "compute_hours")
    if compute_hours is None:
        compute_hours = _get(manifest, "training", "compute_hours")
    gpu_class = _get(manifest, "gpu_class")
    if gpu_class is None:
        gpu_class = _get(manifest, "training", "gpu_class")

    if not isinstance(compute_hours, (int, float)) or compute_hours <= 0:
        return {
            "compute_hours": HONEST_NOT_DISCLOSED,
            "gpu_class": gpu_class if isinstance(gpu_class, str) else HONEST_NOT_DISCLOSED,
            "estimated_co2_kg": HONEST_NOT_DISCLOSED,
            "methodology": "static_grid_average_w768_v1",
            "honest_caveat": "estimate_not_measured",
            "reason": "missing_compute_hours",
        }
    kw = _gpu_class_kw(gpu_class)
    if kw is None:
        return {
            "compute_hours": float(compute_hours),
            "gpu_class": gpu_class if isinstance(gpu_class, str) else HONEST_NOT_DISCLOSED,
            "estimated_co2_kg": HONEST_NOT_DISCLOSED,
            "methodology": "static_grid_average_w768_v1",
            "honest_caveat": "estimate_not_measured",
            "reason": "unknown_gpu_class",
            "known_gpu_classes": sorted(GPU_CLASS_KW.keys()),
        }
    co2_kg = round(float(compute_hours) * kw * GLOBAL_GRID_CO2_KG_PER_KWH, 4)
    return {
        "compute_hours": float(compute_hours),
        "gpu_class": gpu_class,
        "gpu_class_kw": kw,
        "grid_co2_kg_per_kwh": GLOBAL_GRID_CO2_KG_PER_KWH,
        "estimated_co2_kg": co2_kg,
        "methodology": "static_grid_average_w768_v1",
        "honest_caveat": "estimate_not_measured",
    }


def build_model_card(manifest: dict, *, include_environmental: bool = False) -> dict:
    """Build the full 10-section HF v0.3 model card from a kolm manifest.

    HONESTY CONTRACT: every field that the manifest does not supply emits
    HONEST_NOT_DISCLOSED ("not_yet_disclosed"). We NEVER synthesize.
    """
    if not isinstance(manifest, dict):
        manifest = {}

    # 1. model_details
    model_details = {
        "name": _str_or_disclose(manifest.get("name") or manifest.get("model_name")),
        "version": _str_or_disclose(
            manifest.get("version") or manifest.get("spec_hash") or manifest.get("artifact_hash")
        ),
        "developed_by": _str_or_disclose(
            _get(manifest, "developed_by") or _get(manifest, "owner") or _get(manifest, "tenant_id")
        ),
        "model_type": _str_or_disclose(
            _get(manifest, "model_type") or _get(manifest, "task")
        ),
        "license": _str_or_disclose(_get(manifest, "license")),
        "base_model": _str_or_disclose(
            _get(manifest, "base_model") or _get(manifest, "teacher_model")
        ),
        "framework": _str_or_disclose(_get(manifest, "framework")),
        "languages": _list_or_disclose(_get(manifest, "languages")),
    }

    # 2. intended_use
    intended_use = {
        "primary_uses": _str_or_disclose(_get(manifest, "intended_use", "primary_uses")),
        "primary_users": _str_or_disclose(_get(manifest, "intended_use", "primary_users")),
        "out_of_scope_uses": _list_or_disclose(_get(manifest, "intended_use", "out_of_scope_uses")),
    }

    # 3. factors
    factors = {
        "relevant_factors": _list_or_disclose(_get(manifest, "factors", "relevant")),
        "evaluation_factors": _list_or_disclose(_get(manifest, "factors", "evaluation")),
    }

    # 4. metrics
    raw_metrics = _get(manifest, "metrics") or _get(manifest, "eval_metrics")
    metrics = {
        "performance_measures": _list_or_disclose(
            _get(manifest, "metrics", "performance_measures")
        ),
        "decision_thresholds": _str_or_disclose(
            _get(manifest, "metrics", "decision_thresholds")
        ),
        "variation_approaches": _str_or_disclose(
            _get(manifest, "metrics", "variation_approaches")
        ),
        "values": raw_metrics if isinstance(raw_metrics, dict) else HONEST_NOT_DISCLOSED,
    }

    # 5. evaluation_data
    evaluation_data = {
        "datasets": _list_or_disclose(_get(manifest, "evaluation_data", "datasets")),
        "motivation": _str_or_disclose(_get(manifest, "evaluation_data", "motivation")),
        "preprocessing": _str_or_disclose(_get(manifest, "evaluation_data", "preprocessing")),
    }

    # 6. training_data
    training_data = {
        "datasets": _list_or_disclose(
            _get(manifest, "training_data", "datasets") or _get(manifest, "training", "datasets")
        ),
        "size": _str_or_disclose(
            _get(manifest, "training_data", "size") or _get(manifest, "training", "size")
        ),
        "preprocessing": _str_or_disclose(
            _get(manifest, "training_data", "preprocessing")
            or _get(manifest, "training", "preprocessing")
        ),
        "capture_count": (
            _get(manifest, "training_data", "capture_count")
            or _get(manifest, "training", "capture_count")
            or HONEST_NOT_DISCLOSED
        ),
    }

    # 7. quantitative_analyses
    quantitative_analyses = {
        "unitary_results": (
            _get(manifest, "quantitative_analyses", "unitary_results") or HONEST_NOT_DISCLOSED
        ),
        "intersectional_results": (
            _get(manifest, "quantitative_analyses", "intersectional_results")
            or HONEST_NOT_DISCLOSED
        ),
    }

    # 8. ethical_considerations
    ethical_considerations = {
        "sensitive_data": _str_or_disclose(_get(manifest, "ethical_considerations", "sensitive_data")),
        "human_life": _str_or_disclose(_get(manifest, "ethical_considerations", "human_life")),
        "mitigations": _list_or_disclose(_get(manifest, "ethical_considerations", "mitigations")),
        "risks_and_harms": _list_or_disclose(
            _get(manifest, "ethical_considerations", "risks_and_harms")
        ),
        "use_cases": _list_or_disclose(_get(manifest, "ethical_considerations", "use_cases")),
    }

    # 9. caveats_and_recommendations
    caveats_and_recommendations = {
        "caveats": _list_or_disclose(_get(manifest, "caveats_and_recommendations", "caveats")),
        "recommendations": _list_or_disclose(
            _get(manifest, "caveats_and_recommendations", "recommendations")
        ),
    }

    # 10. environmental_impact
    if include_environmental:
        environmental_impact = estimate_environmental_impact(manifest)
    else:
        environmental_impact = {
            "compute_hours": HONEST_NOT_DISCLOSED,
            "gpu_class": HONEST_NOT_DISCLOSED,
            "estimated_co2_kg": HONEST_NOT_DISCLOSED,
            "methodology": "static_grid_average_w768_v1",
            "honest_caveat": "estimate_not_measured",
            "reason": "environmental_estimate_not_requested",
        }

    return {
        "model_details": model_details,
        "intended_use": intended_use,
        "factors": factors,
        "metrics": metrics,
        "evaluation_data": evaluation_data,
        "training_data": training_data,
        "quantitative_analyses": quantitative_analyses,
        "ethical_considerations": ethical_considerations,
        "caveats_and_recommendations": caveats_and_recommendations,
        "environmental_impact": environmental_impact,
    }


def _md_section(title: str, body: Any) -> str:
    """Render one section of the HF-standard markdown."""
    out = ["## " + title, ""]
    if isinstance(body, dict):
        for k, v in body.items():
            label = k.replace("_", " ").capitalize()
            if isinstance(v, list):
                if not v:
                    out.append(f"- **{label}:** {HONEST_NOT_DISCLOSED}")
                else:
                    out.append(f"- **{label}:**")
                    for item in v:
                        out.append(f"  - {item}")
            elif isinstance(v, dict):
                out.append(f"- **{label}:**")
                for kk, vv in v.items():
                    out.append(f"  - `{kk}`: {vv}")
            else:
                out.append(f"- **{label}:** {v}")
    elif isinstance(body, list):
        for item in body:
            out.append(f"- {item}")
    else:
        out.append(str(body))
    out.append("")
    return "\n".join(out)


def format_as_markdown(card: dict) -> str:
    """Render the card envelope as HF-standard markdown."""
    lines = [
        "# Model Card",
        "",
        "_Generated by kolm.ai " + MODEL_CARD_VERSION + " - Hugging Face Model Card v0.3 standard._",
        "",
    ]
    for section in MODEL_CARD_SECTIONS:
        title = section.replace("_", " ").title()
        body = card.get(section, HONEST_NOT_DISCLOSED)
        lines.append(_md_section(title, body))
    return "\n".join(lines)


def format_as_huggingface(card: dict) -> str:
    """Wrap the markdown body with HF YAML frontmatter."""
    md = _get(card, "model_details") or {}
    name = md.get("name") if isinstance(md, dict) else HONEST_NOT_DISCLOSED
    languages = md.get("languages") if isinstance(md, dict) else HONEST_NOT_DISCLOSED
    license_ = md.get("license") if isinstance(md, dict) else HONEST_NOT_DISCLOSED
    base_model = md.get("base_model") if isinstance(md, dict) else HONEST_NOT_DISCLOSED

    fm_lines = ["---"]
    if languages != HONEST_NOT_DISCLOSED and isinstance(languages, list):
        fm_lines.append("language:")
        for lang in languages:
            fm_lines.append(f"  - {lang}")
    fm_lines.append(f'license: {license_ if license_ != HONEST_NOT_DISCLOSED else "other"}')
    if base_model != HONEST_NOT_DISCLOSED:
        fm_lines.append(f"base_model: {base_model}")
    fm_lines.append(f"tags:\n  - kolm\n  - distilled\n  - {MODEL_CARD_VERSION}")
    if name != HONEST_NOT_DISCLOSED:
        fm_lines.append(f"model-index:\n  - name: {name}")
    fm_lines.append("---")
    fm_lines.append("")
    return "\n".join(fm_lines) + format_as_markdown(card)


# =============================================================================
# CLI
# =============================================================================

def _fail(error: str, hint: str = "", code: int = 3) -> int:
    print(json.dumps({
        "ok": False,
        "error": error,
        "hint": hint,
        "version": MODEL_CARD_VERSION,
    }), file=sys.stderr)
    return code


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        description="Auto-generate a Hugging Face Model Card v0.3 from a kolm manifest."
    )
    ap.add_argument("--manifest", help="kolm manifest.json (required)")
    ap.add_argument("--out", "-o", help="write JSON envelope to this path instead of stdout")
    ap.add_argument(
        "--format",
        choices=list(MODEL_CARD_FORMATS),
        default="json",
        help="output format (default: json)",
    )
    ap.add_argument(
        "--include-environmental",
        action="store_true",
        help="compute estimated CO2 from manifest.compute_hours + manifest.gpu_class",
    )
    args = ap.parse_args(argv[1:])

    if not args.manifest:
        return _fail(
            "manifest_required",
            "pass --manifest <path-to-manifest.json>",
            code=2,
        )

    p = Path(args.manifest)
    if not p.is_file():
        return _fail("manifest_not_found", f"path: {args.manifest}", code=2)
    try:
        raw = p.read_text(encoding="utf-8")
    except OSError as e:
        return _fail("manifest_read_failed", str(e), code=2)
    try:
        manifest = json.loads(raw)
    except json.JSONDecodeError as e:
        return _fail("manifest_parse_failed", f"{type(e).__name__}: {e}", code=2)

    card = build_model_card(manifest, include_environmental=args.include_environmental)
    generated_at = (
        datetime.datetime.now(datetime.timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )

    if args.format == "json":
        envelope: dict = {
            "ok": True,
            "version": MODEL_CARD_VERSION,
            "format": "json",
            "generated_at": generated_at,
            "card": card,
        }
        serialized = json.dumps(envelope, indent=2, sort_keys=False)
    elif args.format == "markdown":
        body = format_as_markdown(card)
        envelope = {
            "ok": True,
            "version": MODEL_CARD_VERSION,
            "format": "markdown",
            "generated_at": generated_at,
            "card": card,
            "markdown": body,
        }
        serialized = json.dumps(envelope, indent=2, sort_keys=False)
    elif args.format == "huggingface":
        body = format_as_huggingface(card)
        envelope = {
            "ok": True,
            "version": MODEL_CARD_VERSION,
            "format": "huggingface",
            "generated_at": generated_at,
            "card": card,
            "huggingface": body,
        }
        serialized = json.dumps(envelope, indent=2, sort_keys=False)
    else:
        return _fail("unsupported_format",
                     "format must be one of " + ", ".join(MODEL_CARD_FORMATS))

    if args.out:
        out = Path(args.out)
        try:
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(serialized + "\n", encoding="utf-8")
        except OSError as e:
            return _fail("output_write_failed", str(e))
        print(json.dumps({
            "ok": True,
            "version": MODEL_CARD_VERSION,
            "format": args.format,
            "output": str(out.resolve()),
        }))
    else:
        print(serialized)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
