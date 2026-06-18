# Master Component Spec Sheet

Generated 2026-06-17. Source of truth: `docs/backend-atomic-component-deep-dive-2026-06-17.json`, `docs/whole-stack-sota-deep-dive-2026-06-17.json`, and `docs/product-sota-readiness.json`.

This is the optimization sheet for the deep-dive workflow. The JSON companion contains one row per backend component; this Markdown file carries the operating summary and the highest-priority gaps.

## How Close To Perfect

- Local engineering perfection: **93.6/100**
- Frontier/product perfection: **70.1/100**
- Atomic components inventoried: **829**
- Atomic deep dives complete: **100%**
- Direct test referenced: **728/829 (87.8%)**
- High-priority direct test referenced: **49/49 (100%)**
- Readiness closed locally: **49/57 (86%)**
- SOTA categories still carrying critical work: **10/16**
- SOTA categories still carrying major work: **13/16**

Interpretation: local code/spec discipline is strong and fully inventoried, but true perfection is lower because frontier gaps and external readiness gates remain open. A perfect score requires zero critical/major SOTA gaps and no external/package/certification/benchmark gates left.

## Category Targets

| Category | Area | Status | Frontier | Required Components | Verification |
| --- | --- | --- | --- | --- | --- |
| distillation | training | sota_review_complete_critical_frontier_work_open | at=11 open=1/0/2 | 3 | npm run verify:stack-sota<br>npm run verify:inventions |
| moe-distill-quant | training | sota_review_complete_critical_frontier_work_open | at=6 open=2/2/2 | 4 | npm run verify:stack-sota<br>npm run verify:inventions |
| quantization | compiler-runtime | sota_review_complete_major_frontier_work_open | at=10 open=0/4/1 | 3 | npm run verify:stack-sota<br>npm run verify:quant-oracle |
| kv-cache | runtime | sota_review_complete_major_frontier_work_open | at=8 open=0/2/2 | 3 | npm run verify:stack-sota<br>npm run verify:surfaces |
| speculative-decoding | runtime | sota_review_complete_critical_frontier_work_open | at=7 open=1/1/1 | 3 | npm run verify:stack-sota<br>npm run verify:surfaces |
| finetune-frameworks | training | sota_review_complete_major_frontier_work_open | at=10 open=0/1/4 | 3 | npm run verify:stack-sota<br>npm run verify:inventions |
| synthetic-data-curation | data | sota_review_complete_critical_frontier_work_open | at=7 open=1/2/1 | 3 | npm run verify:stack-sota<br>npm run verify:redaction-benchmark |
| small-llm-students | model-registry | sota_review_complete_critical_frontier_work_open | at=6 open=1/0/2 | 3 | npm run verify:stack-sota<br>npm run verify:inventions |
| ondevice-inference | cross-device | sota_review_complete_critical_frontier_work_open | at=5 open=1/2/2 | 3 | npm run verify:stack-sota<br>npm run verify:platform |
| llm-routing | gateway | sota_review_complete_major_frontier_work_open | at=7 open=0/2/2 | 3 | npm run verify:stack-sota<br>npm run verify:surfaces |
| mcp-tool-gateway-receipts | agent-integrations | sota_review_complete_major_frontier_work_open | at=11 open=0/1/2 | 3 | npm run verify:stack-sota<br>npm run verify:governance-packets |
| verifiable-inference | trust | sota_review_complete_critical_frontier_work_open | at=8 open=2/1/1 | 4 | npm run verify:stack-sota<br>npm run verify:compliance-packet |
| model-signing-standards | trust | sota_review_complete_external_or_release_gate_open | at=8 open=0/0/1 | 4 | npm run verify:stack-sota<br>npm run verify:compliance-packet |
| confidential-compute | enterprise | sota_review_complete_critical_frontier_work_open | at=7 open=1/2/1 | 4 | npm run verify:stack-sota<br>npm run verify:compliance-packet |
| agent-security-eval | enterprise | sota_review_complete_critical_frontier_work_open | at=7 open=1/2/1 | 3 | npm run verify:stack-sota<br>npm run verify:compliance-packet |
| compile-api-to-model-competitors | compiler-platform | sota_review_complete_critical_frontier_work_open | at=9 open=1/1/4 | 4 | npm run verify:stack-sota<br>npm run verify:inventions |

## Top Component Gaps

| Component | Domain | Priority | Gaps | Next Action |
| --- | --- | --- | --- | --- |
| `src/router.js` | api_surface | 13 | linked_frontier_work_open | Execute the linked frontier track: split_or_add_generated_contract_map_before_growth. |
| `cli/kolm.js` | developer_distribution | 11 | linked_frontier_work_open | Execute the linked frontier track: split_or_add_generated_contract_map_before_growth. |
| `src/audit-routes.js` | api_surface | 11 | linked_frontier_work_open | Execute the linked frontier track: split_or_add_generated_contract_map_before_growth. |
| `src/daemon-connector.js` | platform_support | 11 | linked_frontier_work_open | Execute the linked frontier track: maintain_contract_tests_and_claim_scope_mapping. |
| `workers/quantize/scripts/quantize.py` | training_model_optimization | 10 | linked_frontier_work_open | Execute the linked frontier track: split_or_add_generated_contract_map_before_growth. |
| `src/deploy-generators.js` | infra_cloud_device | 9 | open_marker_requires_owner_review<br>linked_frontier_work_open | Resolve or explicitly owner-review the open TODO/FIXME marker. |
| `cli/kolm-tui.mjs` | developer_distribution | 9 | linked_frontier_work_open | Execute the linked frontier track: generated_package_sdk_conformance_and_release_evidence. |
| `src/bench-harness.js` | capture_data_eval | 9 | linked_frontier_work_open | Execute the linked frontier track: measurement_harness_data_value_and_holdout_leakage_guards. |
| `src/binder.js` | platform_support | 9 | linked_frontier_work_open | Execute the linked frontier track: split_or_add_generated_contract_map_before_growth. |
| `src/data-curate.js` | capture_data_eval | 9 | linked_frontier_work_open | Execute the linked frontier track: split_or_add_generated_contract_map_before_growth. |
| `src/distill-pipeline.js` | training_model_optimization | 9 | linked_frontier_work_open | Execute the linked frontier track: split_or_add_generated_contract_map_before_growth. |
| `src/intent.js` | platform_support | 9 | linked_frontier_work_open | Execute the linked frontier track: split_or_add_generated_contract_map_before_growth. |
| `src/otel.js` | platform_support | 9 | linked_frontier_work_open | Execute the linked frontier track: maintain_contract_tests_and_claim_scope_mapping. |
| `src/spec-compile.js` | compile_artifact_runtime | 9 | linked_frontier_work_open | Execute the linked frontier track: split_or_add_generated_contract_map_before_growth. |
| `src/wrapper-cli.js` | compile_artifact_runtime | 9 | linked_frontier_work_open | Execute the linked frontier track: split_or_add_generated_contract_map_before_growth. |
| `workers/distill/scripts/dedup_pairs.py` | training_model_optimization | 9 | linked_frontier_work_open | Execute the linked frontier track: frontier_method_wiring_probe_harness_and_method_bakeoff. |
| `workers/distill/scripts/train_preference.py` | training_model_optimization | 9 | linked_frontier_work_open | Execute the linked frontier track: frontier_method_wiring_probe_harness_and_method_bakeoff. |
| `server.js` | api_surface | 8 | linked_frontier_work_open | Execute the linked frontier track: route_contract_auth_idempotency_and_error_shape_matrix. |
| `src/artifact.js` | compile_artifact_runtime | 8 | linked_frontier_work_open | Execute the linked frontier track: split_or_add_generated_contract_map_before_growth. |
| `src/attestation-report-builder.js` | trust_security_compliance | 8 | linked_frontier_work_open | Execute the linked frontier track: split_or_add_generated_contract_map_before_growth. |

## Machine Sheet

Every component row is in `docs/master-component-spec-sheet-2026-06-17.json` under `components[]`. Each row includes composition metrics, risk signals, category links, current tests, target state, perfection gaps, next best action, and suggested verification.
