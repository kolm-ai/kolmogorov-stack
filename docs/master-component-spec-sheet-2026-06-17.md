# Master Component Spec Sheet

Generated 2026-06-17. Source of truth: `docs/backend-atomic-component-deep-dive-2026-06-17.json`, `docs/whole-stack-sota-deep-dive-2026-06-17.json`, and `docs/product-sota-readiness.json`.

This is the optimization sheet for the deep-dive workflow. The JSON companion contains one row per backend component; this Markdown file carries the operating summary and the highest-priority gaps.

## How Close To Perfect

- Local engineering perfection: **100/100**
- Frontier/product perfection: **97.2/100**
- Atomic components inventoried: **978**
- Atomic deep dives complete: **100%**
- Direct test referenced: **978/978 (100%)**
- High-priority direct test referenced: **68/68 (100%)**
- Local readiness proof coverage: **57/57 (100%)**
- Claimable readiness closed locally: **49/57 (86%)**
- Readiness proof surplus hill-climb: **104.3/110**
- Language fit: **js_control_plane_with_python_rust_native_escape_hatches**
- SOTA categories still carrying critical work: **0/16**
- SOTA categories still carrying major work: **0/16**

Interpretation: local code/spec discipline and readiness proof coverage are now complete, but claimable frontier/product perfection remains lower because partner adoption, package release, public benchmark data, certification, and SOTA category gaps are still external or frontier-open. Above-100 scoring is limited to local proof surplus and never upgrades an external gate into a shipped claim.

## Category Targets

| Category | Area | Status | Frontier | Required Components | Verification |
| --- | --- | --- | --- | --- | --- |
| distillation | training | sota_review_complete_local_frontier_aligned | at=14 open=0/0/0 | 3 | npm run verify:stack-sota<br>npm run verify:inventions |
| moe-distill-quant | training | sota_review_complete_local_frontier_aligned | at=11 open=0/0/1 | 6 | npm run verify:stack-sota<br>npm run verify:inventions |
| quantization | compiler-runtime | sota_review_complete_external_or_release_gate_open | at=16 open=0/0/0 | 4 | npm run verify:stack-sota<br>npm run verify:quant-oracle |
| kv-cache | runtime | sota_review_complete_external_or_release_gate_open | at=9 open=0/0/0 | 4 | npm run verify:stack-sota<br>npm run verify:surfaces |
| speculative-decoding | runtime | sota_review_complete_external_or_release_gate_open | at=8 open=0/0/1 | 5 | npm run verify:stack-sota<br>npm run verify:surfaces |
| finetune-frameworks | training | sota_review_complete_external_or_release_gate_open | at=12 open=0/0/3 | 3 | npm run verify:stack-sota<br>npm run verify:inventions |
| synthetic-data-curation | data | sota_review_complete_local_frontier_aligned | at=10 open=0/0/1 | 3 | npm run verify:stack-sota<br>npm run verify:redaction-benchmark |
| small-llm-students | model-registry | sota_review_complete_local_frontier_aligned | at=12 open=0/0/0 | 3 | npm run verify:stack-sota<br>npm run verify:inventions |
| ondevice-inference | cross-device | sota_review_complete_external_or_release_gate_open | at=10 open=0/0/1 | 3 | npm run verify:stack-sota<br>npm run verify:platform |
| llm-routing | gateway | sota_review_complete_external_or_release_gate_open | at=12 open=0/0/0 | 3 | npm run verify:stack-sota<br>npm run verify:surfaces |
| mcp-tool-gateway-receipts | agent-integrations | sota_review_complete_external_or_release_gate_open | at=15 open=0/0/0 | 3 | npm run verify:stack-sota<br>npm run verify:governance-packets |
| verifiable-inference | trust | sota_review_complete_external_or_release_gate_open | at=15 open=0/0/1 | 5 | npm run verify:stack-sota<br>npm run verify:compliance-packet |
| model-signing-standards | trust | sota_review_complete_external_or_release_gate_open | at=9 open=0/0/2 | 4 | npm run verify:stack-sota<br>npm run verify:compliance-packet |
| confidential-compute | enterprise | sota_review_complete_external_or_release_gate_open | at=10 open=0/0/1 | 4 | npm run verify:stack-sota<br>npm run verify:compliance-packet |
| agent-security-eval | enterprise | sota_review_complete_external_or_release_gate_open | at=8 open=0/0/1 | 4 | npm run verify:stack-sota<br>npm run verify:compliance-packet |
| compile-api-to-model-competitors | compiler-platform | sota_review_complete_external_or_release_gate_open | at=11 open=0/0/4 | 4 | npm run verify:stack-sota<br>npm run verify:inventions |

## Top Component Gaps

| Component | Domain | Priority | Gaps | Next Action |
| --- | --- | --- | --- | --- |

## Machine Sheet

Every component row is in `docs/master-component-spec-sheet-2026-06-17.json` under `components[]`. Each row includes composition metrics, risk signals, category links, current tests, target state, perfection gaps, next best action, and suggested verification.
