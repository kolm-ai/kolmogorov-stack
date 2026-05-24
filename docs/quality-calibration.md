# Quality Judge Calibration

Kolm now has a deterministic backend contract for quality-judge calibration.
It proves the rubric math, confusion matrix, agreement calculation, Brier
score, task-type breakdown, and route/script plumbing. It does not claim broad
judge validity until external labeled data exists.

## Contract

- Module: `src/quality-calibration.js`
- Script: `node scripts/quality-calibration.mjs --summary --require-local-contract`
- API: `GET /v1/eval/quality-calibration`
- Product requirement: `quality-scoring`

The fixture spans extraction, generation, classification, privacy, code, legal,
translation, and safety tasks. Each row includes:

- gold pass/fail label from a local rubric fixture
- predicted pass/fail from the configured score threshold
- judge score
- confidence
- dimension scores for task success, factuality, format, safety, privacy, and
  robustness

## Promotion Gate

The local gate passes when:

- at least 16 calibration rows are present
- agreement is at least 0.85
- F1 is at least 0.85
- Brier score is at most 0.18

The public-claim gate stays closed until there is an external human-labeled
set, a cross-model judge panel, and a public raw prompt/output corpus.

## Research Baseline

- MT-Bench / Chatbot Arena: judge bias and human-preference agreement checks:
  https://arxiv.org/abs/2306.05685
- G-Eval: rubric-style generation scoring:
  https://arxiv.org/abs/2303.16634
- HELM: multi-metric reporting and transparent missing coverage:
  https://arxiv.org/abs/2211.09110

## Next External Proof

Run the same rubric on a larger external label set and publish the anonymized
raw prompts, outputs, labels, judge scores, and disagreement analysis. When that
exists, the `quality-scoring` requirement can move from
`needs_public_benchmark_data` to `implemented`.
