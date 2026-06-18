# Master Component Spec Sheet

Generated 2026-06-17. Source of truth: `docs/backend-atomic-component-deep-dive-2026-06-17.json`, `docs/whole-stack-sota-deep-dive-2026-06-17.json`, and `docs/product-sota-readiness.json`.

This is the optimization sheet for the deep-dive workflow. The JSON companion contains one row per backend component; this Markdown file carries the operating summary and the highest-priority gaps.

## How Close To Perfect

- Local engineering perfection: **100/100**
- Frontier/product perfection: **83.2/100**
- Atomic components inventoried: **969**
- Atomic deep dives complete: **100%**
- Direct test referenced: **969/969 (100%)**
- High-priority direct test referenced: **66/66 (100%)**
- Local readiness proof coverage: **57/57 (100%)**
- Claimable readiness closed locally: **49/57 (86%)**
- Readiness proof surplus hill-climb: **104.3/110**
- Language fit: **js_control_plane_with_python_rust_native_escape_hatches**
- SOTA categories still carrying critical work: **3/16**
- SOTA categories still carrying major work: **11/16**

Interpretation: local code/spec discipline and readiness proof coverage are now complete, but claimable frontier/product perfection remains lower because partner adoption, package release, public benchmark data, certification, and SOTA category gaps are still external or frontier-open. Above-100 scoring is limited to local proof surplus and never upgrades an external gate into a shipped claim.

## Category Targets

| Category | Area | Status | Frontier | Required Components | Verification |
| --- | --- | --- | --- | --- | --- |
| distillation | training | sota_review_complete_local_frontier_aligned | at=12 open=0/0/2 | 3 | npm run verify:stack-sota<br>npm run verify:inventions |
| moe-distill-quant | training | sota_review_complete_major_frontier_work_open | at=7 open=0/4/2 | 6 | npm run verify:stack-sota<br>npm run verify:inventions |
| quantization | compiler-runtime | sota_review_complete_major_frontier_work_open | at=12 open=0/3/1 | 3 | npm run verify:stack-sota<br>npm run verify:quant-oracle |
| kv-cache | runtime | sota_review_complete_major_frontier_work_open | at=8 open=0/2/2 | 3 | npm run verify:stack-sota<br>npm run verify:surfaces |
| speculative-decoding | runtime | sota_review_complete_major_frontier_work_open | at=8 open=0/1/1 | 4 | npm run verify:stack-sota<br>npm run verify:surfaces |
| finetune-frameworks | training | sota_review_complete_external_or_release_gate_open | at=11 open=0/0/4 | 3 | npm run verify:stack-sota<br>npm run verify:inventions |
| synthetic-data-curation | data | sota_review_complete_major_frontier_work_open | at=8 open=0/3/1 | 3 | npm run verify:stack-sota<br>npm run verify:redaction-benchmark |
| small-llm-students | model-registry | sota_review_complete_critical_frontier_work_open | at=9 open=1/0/2 | 3 | npm run verify:stack-sota<br>npm run verify:inventions |
| ondevice-inference | cross-device | sota_review_complete_major_frontier_work_open | at=7 open=0/1/2 | 3 | npm run verify:stack-sota<br>npm run verify:platform |
| llm-routing | gateway | sota_review_complete_major_frontier_work_open | at=7 open=0/2/2 | 3 | npm run verify:stack-sota<br>npm run verify:surfaces |
| mcp-tool-gateway-receipts | agent-integrations | sota_review_complete_external_or_release_gate_open | at=12 open=0/0/2 | 3 | npm run verify:stack-sota<br>npm run verify:governance-packets |
| verifiable-inference | trust | sota_review_complete_critical_frontier_work_open | at=11 open=1/1/1 | 4 | npm run verify:stack-sota<br>npm run verify:compliance-packet |
| model-signing-standards | trust | sota_review_complete_external_or_release_gate_open | at=8 open=0/0/1 | 4 | npm run verify:stack-sota<br>npm run verify:compliance-packet |
| confidential-compute | enterprise | sota_review_complete_major_frontier_work_open | at=8 open=0/1/1 | 4 | npm run verify:stack-sota<br>npm run verify:compliance-packet |
| agent-security-eval | enterprise | sota_review_complete_major_frontier_work_open | at=8 open=0/2/1 | 3 | npm run verify:stack-sota<br>npm run verify:compliance-packet |
| compile-api-to-model-competitors | compiler-platform | sota_review_complete_critical_frontier_work_open | at=9 open=1/1/4 | 4 | npm run verify:stack-sota<br>npm run verify:inventions |

## Top Component Gaps

| Component | Domain | Priority | Gaps | Next Action |
| --- | --- | --- | --- | --- |
| `src/router.js` | api_surface | 13 | linked_frontier_work_open | Execute the linked frontier track: maintain_generated_api_contract_matrix_and_route_split_plan. |
| `apps/trainer/distill.py` | training_model_optimization | 12 | linked_frontier_work_open | Execute the linked frontier track: split_or_add_generated_contract_map_before_growth. |
| `cli/kolm.js` | developer_distribution | 11 | linked_frontier_work_open | Execute the linked frontier track: maintain_generated_cli_command_matrix_and_split_plan. |
| `src/audit-routes.js` | api_surface | 11 | linked_frontier_work_open | Execute the linked frontier track: maintain_generated_api_contract_matrix_and_route_split_plan. |
| `src/daemon-connector.js` | platform_support | 11 | linked_frontier_work_open | Execute the linked frontier track: maintain_generated_daemon_connector_matrix_and_privacy_proxy_contract. |
| `apps/trainer/main.py` | training_model_optimization | 10 | linked_frontier_work_open | Execute the linked frontier track: frontier_method_wiring_probe_harness_and_method_bakeoff. |
| `src/airgap-distill.js` | training_model_optimization | 10 | linked_frontier_work_open | Execute the linked frontier track: frontier_method_wiring_probe_harness_and_method_bakeoff. |
| `workers/distill/distill.mjs` | training_model_optimization | 10 | linked_frontier_work_open | Execute the linked frontier track: frontier_method_wiring_probe_harness_and_method_bakeoff. |
| `workers/quantize/scripts/quantize.py` | training_model_optimization | 10 | linked_frontier_work_open | Execute the linked frontier track: maintain_generated_quantize_worker_matrix_and_frontier_method_contract. |
| `src/deploy-generators.js` | infra_cloud_device | 9 | open_marker_requires_owner_review<br>linked_frontier_work_open | Resolve or explicitly owner-review the open TODO/FIXME marker. |
| `apps/trainer/multinode_launch.py` | training_model_optimization | 9 | linked_frontier_work_open | Execute the linked frontier track: frontier_method_wiring_probe_harness_and_method_bakeoff. |
| `cli/kolm-tui.mjs` | developer_distribution | 9 | linked_frontier_work_open | Execute the linked frontier track: maintain_generated_tui_workbench_matrix_and_cli_distribution_contract. |
| `src/bench-harness.js` | capture_data_eval | 9 | linked_frontier_work_open | Execute the linked frontier track: maintain_generated_bench_harness_matrix_and_privacy_safe_measurement_contract. |
| `src/binder.js` | platform_support | 9 | linked_frontier_work_open | Execute the linked frontier track: maintain_generated_binder_contract_matrix_and_verifier_failure_taxonomy. |
| `src/data-curate.js` | capture_data_eval | 9 | linked_frontier_work_open | Execute the linked frontier track: split_or_add_generated_contract_map_before_growth. |
| `src/distill-pipeline.js` | training_model_optimization | 9 | linked_frontier_work_open | Execute the linked frontier track: maintain_generated_distill_pipeline_matrix_and_training_orchestrator_contract. |
| `src/intent.js` | platform_support | 9 | linked_frontier_work_open | Execute the linked frontier track: maintain_generated_intent_contract_matrix_and_routing_workflow_taxonomy. |
| `src/otel.js` | platform_support | 9 | linked_frontier_work_open | Execute the linked frontier track: maintain_generated_otel_matrix_and_privacy_safe_semconv_contract. |
| `src/spec-compile.js` | compile_artifact_runtime | 9 | linked_frontier_work_open | Execute the linked frontier track: maintain_generated_spec_compile_matrix_and_signed_artifact_compiler_contract. |
| `src/wrapper-cli.js` | compile_artifact_runtime | 9 | linked_frontier_work_open | Execute the linked frontier track: maintain_generated_wrapper_cli_matrix_and_gateway_capture_receipt_namespace_contract. |

## Machine Sheet

Every component row is in `docs/master-component-spec-sheet-2026-06-17.json` under `components[]`. Each row includes composition metrics, risk signals, category links, current tests, target state, perfection gaps, next best action, and suggested verification.
