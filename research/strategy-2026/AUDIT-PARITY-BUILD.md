# Audit-type / request parity — build lock list

Source: `parity-matrix-raw.json` (audit-parity-hunt workflow: 5 inventory + 4 market agents -> synthesis -> completeness critic, all file:line-verified).

## Parity verdict
kolm is at/beyond parity on the audit spine: 8 ASR controls + 12+2 red-team battery, full session/scan/verify/Trust-Link/continuous request surface, 19 providers + 4 gateways + OTEL/LangSmith/Datadog ingest, CSV/XLSX/Drata/Vanta/OneTrust/ServiceNow/IBM exports, HTML/PDF, SIEM CEF/LEEF, CycloneDX+SPDX SBOM, in-toto/SLSA/cosign+Rekor, offline Ed25519 verify with .well-known keys + Python/Go/Rust/C verifier SDKs. Where competitors lead (model-weight scanning, fairness/bias, AI discovery, drift) is correctly out of scope (needs model/dataset access kolm does not take).

## LOCK list (low/mid effort, reuses existing registries; constraint-safe)

### Exports (framework-export.js EXPORTERS registry; each new format auto-flows through every export route)
- toSarif       - SARIF 2.1.0 runs[].results from findings + red-team probes (CI/CD ingest). LOW.
- toAibom       - CycloneDX 1.6 ML-BOM from passport models + retrieval sources + MCP. MID, high value.
- toOscal       - OSCAL assessment-results from controlEvidenceRecords(). MID.
- toScorecard   - compact readiness scorecard (md/json) reusing exec-summary + delta. LOW.
- toModelCard   - register existing reg-model-card-extended builder as an export. LOW, high value.
- renderBadgeSvg - shields-style readiness badge (pure SVG). LOW.

### Questionnaires (questionnaire-autofill.js TEMPLATES; auto-exposed via QUESTIONNAIRE_TEMPLATES + routes)
- ai-caiq         - CSA AICM / AI-CAIQ representative template. LOW, high value.
- sig-core        - broader SIG Core representative template. LOW.
- vsaq            - Vendor Security Alliance representative template. LOW.
- eu-ai-act-fria  - FRIA (fundamental-rights impact assessment) template. LOW.
- eu-ai-act       - EXTEND existing template with Art.9 (risk mgmt), Art.11 (technical doc), Art.15 (accuracy/robustness). LOW.

### Framework spine (control-mapper.js CONTROL_MAP; cascades into CSV/Drata/Vanta/crosswalk/questionnaire)
- ISO/IEC 27001:2022 Annex A subset (A.8 access, A.8.15 logging, A.5.23 cloud/AI). LOW, high value.
- HIPAA Security Rule subset (164.312 a/b/e). LOW. MUST label as mapping only (forbidden: "HIPAA-ready").
- EU AI Act Art.9/11/15 spine rows. LOW. No "EU AI Act compliant" string (forbidden).
- NIST SP 800-53 agent-relevant subset (AC/IA/AU/SR). LOW.

### Ingest (connectors/ pattern; high-demand low-effort only)
- src/connectors/openinference.js - Arize Phoenix / OpenInference trace normalize. LOW, high value.
- src/connectors/langfuse.js      - Langfuse trace-data-model normalize. LOW, high value.
- audit-ingest.js coerceExchange  - OpenAI Assistants/Responses API shape branch. LOW, high value.

### Request surface
- notifications.js                - add 'audit_report_ready' + 'reattestation_drift' event types + slack blocks.
- asr-fulfillment.js              - fire reattestation_drift on drift + audit_report_ready on fresh report.
- audit-routes.js                 - POST /v1/audit/sessions/:id/delta?against=<id> (auth) + GET /v1/trust/:slug/badge.svg (public).
- auth.js                         - allow-list the public badge route.

## Documented (HAVE via OTLP, no build): Haystack, Semantic Kernel, MLflow, Traceloop OpenLLMetry, SigNoz -> all emit OTEL GenAI semconv, covered by connectors/otel.js.

## Fast-follow (mid, lower demand): CrewAI + AutoGen importers (semi-structured); multi-turn/roleplay jailbreak probes.

## Deferred (high effort / out of scope, by design): runtime guardrail enforcement, breach/posture A-F scoring, model-weight scanning, fairness/bias, drift PSI/KL, $25k named co-signer, HITRUST CSF, NIST CSF 2.0 Cyber-AI-Profile, DORA attestation.
