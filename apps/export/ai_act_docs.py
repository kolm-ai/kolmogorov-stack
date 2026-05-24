#!/usr/bin/env python3
"""W766 — EU AI Act Annex IV technical documentation generator.

Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 588-594):
    [W766-1] Auto-generate AI Act technical documentation from .kolm artifacts
    [W766-2] Risk scoring based on artifact's task category
    [W766-4] Data governance reports
    [W766-5] /compliance/eu-ai-act.html published

Stdlib-only — NO third-party deps. Mirrors the W763 apps/export/sbom.py
contract. The Node-side src/ai-act-export.js carries equivalent logic; this
script is here so CI runners + python-only operators can generate Annex IV
docs without a Node install.

Inputs:
    --manifest         kolm artifact manifest.json (required)
    --out              write the Annex IV envelope to this path
    --format           json | markdown (default json)
    --risk-category    optional override (minimal | limited | high | unacceptable)

Output (when --out is omitted):
    JSON envelope on stdout
        { ok: true, version: 'w766-v1', format: <fmt>,
          generated_at: <iso8601>, risk_assessment: {...},
          annex_iv: { intended_purpose, system_architecture, ... } }

Exit codes:
    0  ok
    2  bad input args
    3  unsupported / missing-input

HONESTY CONTRACT (mirrors src/ai-act-export.js):
    * Fields the manifest does NOT carry are stamped 'not_yet_disclosed' —
      NEVER fabricated. A regulator reading this must see clearly that a
      builder has not yet attested to a given field.
    * scoreArtifactRisk floor is 'minimal' when no taxonomy match exists.
      We NEVER return null risk_category.
    * --risk-category override is accepted but the reasoning string makes it
      clear that an external assessor supplied it.
"""

from __future__ import annotations

import argparse
import datetime
import json
import re
import sys
from pathlib import Path
from typing import Any

AI_ACT_VERSION = "w766-v1"
AI_ACT_RISK_CATEGORIES = ("minimal", "limited", "high", "unacceptable")
AI_ACT_FORMATS = ("json", "markdown")

# Annex IV fields in canonical order so the JSON output is byte-stable.
ANNEX_IV_FIELDS = (
    "intended_purpose",
    "system_architecture",
    "training_data_summary",
    "performance_metrics",
    "risk_management",
    "human_oversight_measures",
    "accuracy_metrics",
    "cybersecurity_measures",
    "postmarket_monitoring_plan",
)

# Honest placeholder for fields the manifest does NOT carry. NEVER fabricate.
NOT_YET_DISCLOSED = "not_yet_disclosed"

# Task category catalog. Mirrors src/ai-act-risk.js's AI_ACT_TASK_CATEGORY_MAP.
# Sourced from Annex III (high-risk) + Article 5 (prohibited) of the EU AI Act.
AI_ACT_TASK_CATEGORY_MAP: dict[str, str] = {
    # unacceptable (Article 5 prohibitions)
    "social_scoring": "unacceptable",
    "subliminal_manipulation": "unacceptable",
    "emotion_recognition_workplace": "unacceptable",
    "real_time_biometric_id_public": "unacceptable",
    "predictive_policing_individual": "unacceptable",
    # high (Annex III)
    "biometric_id": "high",
    "critical_infrastructure": "high",
    "law_enforcement": "high",
    "employment_screening": "high",
    "credit_scoring": "high",
    "medical_diagnosis": "high",
    "border_control": "high",
    "admin_of_justice": "high",
    "education_assessment": "high",
    "essential_services_access": "high",
    "insurance_risk_assessment": "high",
    # limited (Article 50 transparency obligations)
    "chatbot": "limited",
    "generative_text": "limited",
    "generative_image": "limited",
    "deepfake": "limited",
    "voice_synthesis": "limited",
    # minimal (default)
    "spam_filter": "minimal",
    "recommendation": "minimal",
    "code_completion": "minimal",
    "search_ranking": "minimal",
}

VERTICAL_TO_CATEGORY: dict[str, str] = {
    "medical": "high",
    "healthcare": "high",
    "health": "high",
    "legal": "high",
    "justice": "high",
    "financial": "high",
    "finance": "high",
    "insurance": "high",
    "banking": "high",
    "hr": "high",
    "recruiting": "high",
    "employment": "high",
    "education": "high",
    "border": "high",
    "policing": "high",
    "marketing": "limited",
    "copywriting": "limited",
    "chatbot": "limited",
    "developer_tools": "minimal",
    "internal_tools": "minimal",
    "search": "minimal",
}

TRANSPARENCY_BY_CATEGORY: dict[str, list[str]] = {
    "minimal": [],
    "limited": [
        "disclose_ai_interaction_to_user",
        "mark_synthetic_content",
    ],
    "high": [
        "disclose_ai_interaction_to_user",
        "mark_synthetic_content",
        "maintain_annex_iv_documentation",
        "log_runtime_decisions_for_audit",
        "register_in_eu_database",
        "publish_instructions_for_use",
    ],
    "unacceptable": [
        "system_prohibited_no_market_placement",
    ],
}


# =============================================================================
# Helpers
# =============================================================================

def _now_iso() -> str:
    return (
        datetime.datetime.now(datetime.timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _disclosed_or(value: Any) -> Any:
    """Return the manifest value if it's non-empty; otherwise NOT_YET_DISCLOSED.

    Strings are trimmed; lists/dicts checked for non-emptiness. Numbers and
    booleans collapse to NOT_YET_DISCLOSED because Annex IV is narrative.
    """
    if isinstance(value, str):
        s = value.strip()
        return s if s else NOT_YET_DISCLOSED
    if isinstance(value, list):
        return value if len(value) > 0 else NOT_YET_DISCLOSED
    if isinstance(value, dict):
        return value if len(value) > 0 else NOT_YET_DISCLOSED
    return NOT_YET_DISCLOSED


def _normalize_vertical(v: Any) -> str | None:
    if not isinstance(v, str):
        return None
    n = v.strip().lower()
    return n if n else None


def score_artifact_risk(
    manifest: dict, override_risk_category: str | None = None
) -> dict:
    """Return the risk-assessment envelope. Mirrors src/ai-act-risk.js."""
    if not isinstance(manifest, dict):
        return {
            "ok": False,
            "error": "invalid_manifest",
            "hint": "manifest must be an object with at least .vertical or .task_category",
            "version": AI_ACT_VERSION,
        }

    risk_category: str | None = None
    task_category: str | None = None
    reasoning: str | None = None

    if override_risk_category:
        if override_risk_category not in AI_ACT_RISK_CATEGORIES:
            return {
                "ok": False,
                "error": "invalid_risk_category_override",
                "hint": f"must be one of {list(AI_ACT_RISK_CATEGORIES)}",
                "version": AI_ACT_VERSION,
            }
        risk_category = override_risk_category
        tc = manifest.get("task_category") if isinstance(manifest.get("task_category"), str) else None
        task_category = tc
        reasoning = (
            f"risk_category supplied by caller (external assessor override): {override_risk_category}"
        )
    else:
        # 1. Explicit task_category.
        tc = manifest.get("task_category")
        if isinstance(tc, str):
            tc = tc.strip()
            if tc and tc in AI_ACT_TASK_CATEGORY_MAP:
                task_category = tc
                risk_category = AI_ACT_TASK_CATEGORY_MAP[tc]
                reasoning = (
                    f"manifest.task_category='{tc}' maps to risk_category='{risk_category}' "
                    f"per Annex III + Article 5 catalog"
                )

        # 2. Vertical fallback.
        if risk_category is None:
            v = _normalize_vertical(manifest.get("vertical"))
            if v is not None and v in VERTICAL_TO_CATEGORY:
                risk_category = VERTICAL_TO_CATEGORY[v]
                reasoning = (
                    f"manifest.vertical='{v}' implies risk_category='{risk_category}' "
                    "(verticals heuristic)"
                )

        # 3. intended_use free-text classification (lightweight regex pass).
        if risk_category is None:
            iu = manifest.get("intended_use")
            if isinstance(iu, str) and iu.strip():
                guess = _classify_intended_use(iu)
                if guess and guess in AI_ACT_TASK_CATEGORY_MAP:
                    task_category = guess
                    risk_category = AI_ACT_TASK_CATEGORY_MAP[guess]
                    reasoning = (
                        f"intended_use regex classifier -> task_category='{guess}' "
                        f"-> risk_category='{risk_category}'"
                    )

    # 4. Floor — NEVER null, NEVER fabricated.
    if risk_category is None:
        risk_category = "minimal"
        reasoning = (
            "no_task_category_matched — defaulting to minimal risk floor (honest); "
            "supply manifest.task_category for stronger classification"
        )

    transparency = list(TRANSPARENCY_BY_CATEGORY.get(risk_category, []))
    human_oversight_required = risk_category == "high"
    conformity_assessment_required = risk_category == "high"

    return {
        "ok": True,
        "risk_category": risk_category,
        "task_category": task_category,
        "reasoning": reasoning,
        "transparency_requirements": transparency,
        "human_oversight_required": human_oversight_required,
        "conformity_assessment_required": conformity_assessment_required,
        "version": AI_ACT_VERSION,
    }


# Minimal in-Python regex classifier — mirrors the JS classifyTaskCategory.
# Confidence is implicit since we only use this to surface a key (the JS side
# carries the float confidence in its own envelope).
_PY_CLASSIFY_PATTERNS = (
    ("social_scoring", re.compile(r"\bsocial[\s_-]+scor(?:e|ing)\b", re.IGNORECASE)),
    ("subliminal_manipulation", re.compile(r"\bsubliminal\b", re.IGNORECASE)),
    ("medical_diagnosis", re.compile(r"\b(?:medical|clinical|diagnos|patient[\s_-]+chart|radiolog)\b", re.IGNORECASE)),
    ("biometric_id", re.compile(r"\bbiometric\b", re.IGNORECASE)),
    ("critical_infrastructure", re.compile(r"\b(?:power[\s_-]+grid|water[\s_-]+system|critical[\s_-]+infrastructure|scada)\b", re.IGNORECASE)),
    ("law_enforcement", re.compile(r"\b(?:law[\s_-]+enforcement|police|criminal[\s_-]+investigation)\b", re.IGNORECASE)),
    ("employment_screening", re.compile(r"\b(?:resume|cv|applicant|hiring|recruit|employment[\s_-]+screen)\b", re.IGNORECASE)),
    ("credit_scoring", re.compile(r"\b(?:credit[\s_-]+scor|loan[\s_-]+(?:approval|underwrit)|underwrit)\b", re.IGNORECASE)),
    ("border_control", re.compile(r"\b(?:border|customs|immigration|asylum)\b", re.IGNORECASE)),
    ("chatbot", re.compile(r"\b(?:chatbot|conversational[\s_-]+agent|virtual[\s_-]+assistant)\b", re.IGNORECASE)),
    ("generative_text", re.compile(r"\b(?:text[\s_-]+generation|llm|chat[\s_-]+completion)\b", re.IGNORECASE)),
    ("generative_image", re.compile(r"\b(?:image[\s_-]+generation|text[\s_-]+to[\s_-]+image|diffusion[\s_-]+model)\b", re.IGNORECASE)),
    ("deepfake", re.compile(r"\b(?:deepfake|face[\s_-]+swap)\b", re.IGNORECASE)),
    ("voice_synthesis", re.compile(r"\b(?:voice[\s_-]+synthesis|voice[\s_-]+clon|tts|text[\s_-]+to[\s_-]+speech)\b", re.IGNORECASE)),
    ("spam_filter", re.compile(r"\bspam[\s_-]+(?:filter|classif|detect)\b", re.IGNORECASE)),
    ("recommendation", re.compile(r"\b(?:recommend|ranking[\s_-]+system|content[\s_-]+rec)\b", re.IGNORECASE)),
    ("code_completion", re.compile(r"\b(?:code[\s_-]+(?:complet|assist|generat|completion)|copilot|ide[\s_-]+plugin)\b", re.IGNORECASE)),
)


def _classify_intended_use(text: str) -> str | None:
    for key, regex in _PY_CLASSIFY_PATTERNS:
        if regex.search(text):
            return key
    return None


def build_technical_documentation(
    manifest: dict,
    format_: str = "json",
    override_risk_category: str | None = None,
) -> dict:
    """Annex IV envelope. Mirrors src/ai-act-export.js buildTechnicalDocumentation."""
    if not isinstance(manifest, dict):
        return {
            "ok": False,
            "error": "invalid_manifest",
            "hint": "manifest must be a non-null object (kolm artifact manifest.json)",
            "version": AI_ACT_VERSION,
        }

    risk_assessment = score_artifact_risk(manifest, override_risk_category)

    model_block = manifest.get("model")
    captures_summary = manifest.get("captures_summary")
    performance_metrics = manifest.get("performance_metrics")
    confidential_compute = manifest.get("confidential_compute")

    sys_arch_fallback = None
    if isinstance(model_block, dict) and model_block:
        sys_arch_fallback = {
            "base_model": model_block.get("base", NOT_YET_DISCLOSED),
            "quantization": model_block.get("quantization", NOT_YET_DISCLOSED),
            "parameters": model_block.get("parameters", NOT_YET_DISCLOSED),
        }

    training_data_fallback = None
    if isinstance(captures_summary, dict) and captures_summary:
        training_data_fallback = {
            "n_captures": captures_summary.get("n", NOT_YET_DISCLOSED),
            "date_range": captures_summary.get("date_range", NOT_YET_DISCLOSED),
            "source_types": captures_summary.get("source_types", NOT_YET_DISCLOSED),
        }

    accuracy_fallback = None
    if isinstance(performance_metrics, dict) and performance_metrics:
        accuracy_fallback = {
            "accuracy": performance_metrics.get("accuracy", NOT_YET_DISCLOSED),
            "kscore": performance_metrics.get("kscore", NOT_YET_DISCLOSED),
        }

    cyber_fallback = None
    if isinstance(confidential_compute, dict) and confidential_compute:
        cyber_fallback = {
            "attestation_present": True,
            "attestation_kind": confidential_compute.get("attestation_kind", NOT_YET_DISCLOSED),
        }

    oversight_default = None
    if risk_assessment.get("ok") and risk_assessment.get("human_oversight_required"):
        oversight_default = (
            f"Required per Article 14 (risk_category={risk_assessment.get('risk_category')}); "
            f"configure via /v1/compliance/ai-act/human-in-loop"
        )

    annex_iv = {
        "intended_purpose": _disclosed_or(
            manifest.get("intended_purpose")
            or manifest.get("intended_use")
            or manifest.get("purpose")
        ),
        "system_architecture": _disclosed_or(
            manifest.get("system_architecture")
            or manifest.get("architecture")
            or sys_arch_fallback
        ),
        "training_data_summary": _disclosed_or(
            manifest.get("training_data_summary")
            or manifest.get("dataset")
            or training_data_fallback
        ),
        "performance_metrics": _disclosed_or(
            manifest.get("performance_metrics")
            or manifest.get("eval_metrics")
            or manifest.get("metrics")
        ),
        "risk_management": _disclosed_or(
            manifest.get("risk_management")
            or manifest.get("risk_assessment")
        ),
        "human_oversight_measures": _disclosed_or(
            manifest.get("human_oversight_measures")
            or manifest.get("human_in_the_loop")
            or oversight_default
        ),
        "accuracy_metrics": _disclosed_or(
            manifest.get("accuracy_metrics")
            or manifest.get("real_eval")
            or accuracy_fallback
        ),
        "cybersecurity_measures": _disclosed_or(
            manifest.get("cybersecurity_measures")
            or manifest.get("security_measures")
            or cyber_fallback
        ),
        "postmarket_monitoring_plan": _disclosed_or(
            manifest.get("postmarket_monitoring_plan")
            or manifest.get("monitoring_plan")
        ),
    }

    envelope = {
        "ok": True,
        "version": AI_ACT_VERSION,
        "generated_at": _now_iso(),
        "format": format_,
        "risk_assessment": risk_assessment,
        "annex_iv": annex_iv,
    }

    if format_ == "markdown":
        envelope["markdown"] = _render_markdown(envelope)

    return envelope


def _render_markdown(env: dict) -> str:
    lines: list[str] = []
    lines.append("# EU AI Act Technical Documentation (Annex IV)")
    lines.append("")
    lines.append(f"Generated at: {env['generated_at']}")
    lines.append(f"Toolkit version: {env['version']}")
    lines.append("")
    ra = env.get("risk_assessment") or {}
    if ra.get("ok"):
        lines.append("## Risk Assessment")
        lines.append("")
        lines.append(f"- Risk category: {ra.get('risk_category')}")
        if ra.get("task_category"):
            lines.append(f"- Task category: {ra.get('task_category')}")
        lines.append(f"- Reasoning: {ra.get('reasoning')}")
        lines.append(f"- Human oversight required: {ra.get('human_oversight_required')}")
        lines.append(f"- Conformity assessment required: {ra.get('conformity_assessment_required')}")
        lines.append("")
    lines.append("## Annex IV fields")
    lines.append("")
    for key in ANNEX_IV_FIELDS:
        v = env["annex_iv"].get(key)
        lines.append(f"### {key}")
        lines.append("")
        if v == NOT_YET_DISCLOSED:
            lines.append(f"> {NOT_YET_DISCLOSED}")
        elif isinstance(v, str):
            lines.append(v)
        else:
            lines.append("```json")
            lines.append(json.dumps(v, indent=2))
            lines.append("```")
        lines.append("")
    return "\n".join(lines)


def _fail(error: str, hint: str = "", exit_code: int = 3) -> int:
    print(
        json.dumps(
            {
                "ok": False,
                "error": error,
                "hint": hint,
                "version": AI_ACT_VERSION,
            }
        ),
        file=sys.stderr,
    )
    return exit_code


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        description=(
            "Generate an EU AI Act Annex IV technical-documentation envelope "
            "from a kolm artifact manifest."
        )
    )
    ap.add_argument("--manifest", help="path to the kolm artifact manifest.json")
    ap.add_argument("--out", help="write the Annex IV envelope to this path")
    ap.add_argument(
        "--format",
        choices=list(AI_ACT_FORMATS),
        default="json",
        help="output format (default json)",
    )
    ap.add_argument(
        "--risk-category",
        choices=list(AI_ACT_RISK_CATEGORIES),
        help="override the derived risk_category (rare — external assessor use only)",
    )
    args = ap.parse_args(argv[1:])

    if not args.manifest:
        return _fail("manifest_required", "pass --manifest PATH", exit_code=2)

    p = Path(args.manifest)
    if not p.is_file():
        return _fail("manifest_not_found", f"path: {args.manifest}")

    try:
        raw = p.read_text(encoding="utf-8")
    except OSError as e:
        return _fail("manifest_read_failed", str(e))
    try:
        manifest = json.loads(raw)
    except json.JSONDecodeError as e:
        return _fail("manifest_parse_failed", f"{type(e).__name__}: {e}")

    envelope = build_technical_documentation(
        manifest,
        format_=args.format,
        override_risk_category=args.risk_category,
    )

    if not envelope.get("ok"):
        print(json.dumps(envelope), file=sys.stderr)
        return 3

    serialized = json.dumps(envelope, indent=2, sort_keys=False)
    if args.out:
        out = Path(args.out)
        try:
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(serialized + "\n", encoding="utf-8")
        except OSError as e:
            return _fail("out_write_failed", str(e))
        print(
            json.dumps(
                {
                    "ok": True,
                    "version": AI_ACT_VERSION,
                    "format": args.format,
                    "risk_category": envelope["risk_assessment"].get("risk_category"),
                    "out": str(out.resolve()),
                }
            )
        )
    else:
        print(serialized)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
