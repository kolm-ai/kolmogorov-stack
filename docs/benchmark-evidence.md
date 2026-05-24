# Benchmark Evidence Readiness

Kolm now has a backend contract for comparative benchmark evidence. The
contract is intentionally stricter than the local demo leaderboard: public
comparative claims need raw rows across each lane, not only a screenshot or a
summary number.

## Contract

- Module: `src/benchmark-evidence.js`
- Script: `node scripts/benchmark-evidence.mjs --summary --require-local-contract`
- API: `GET /v1/eval/benchmark-evidence`
- Template: `GET /v1/eval/benchmark-evidence/template`
- Validator: `POST /v1/eval/benchmark-evidence/validate`
- Product requirement: `benchmarking-infra`

The local contract verifies that the public K-score suite, local leaderboard,
redaction benchmark, artifact comparison harness, and compare module exist and
parse. The public-claim gate stays closed until `reports/benchmarks/` contains
complete provider lanes for:

- `.kolm` artifact local runner
- OpenAI-compatible API baseline
- Anthropic-native API baseline
- Gemini API baseline
- hosted open-model baseline
- local GGUF baseline
- browser worker baseline

Each lane must include raw-output hashes, pinned model/provider versions,
pricing snapshots, latency fields, quality fields, and hardware or runtime
metadata where applicable.

The provider matrix must also include:

- `spec: "kolm-provider-benchmark-matrix-1"`
- `secret_values_included: false`
- ISO `generated_at`
- `methodology.dataset_version`
- a scoring policy that separates quality, latency, cost, size, energy,
  privacy, and receipt metrics before any composite claim
- a raw-data policy that forbids raw prompts and raw outputs in the public
  manifest
- one non-duplicated row per required lane
- `reports/benchmarks/*.json` or `reports/benchmarks/*.jsonl` report paths
- SHA-256 references for every hash field

```bash
node scripts/benchmark-evidence.mjs --template
node scripts/benchmark-evidence.mjs --validate reports/benchmarks/provider-matrix.json
```

## Research Baseline

- HELM shows why shared scenarios, multiple metrics, raw prompts, raw
  completions, and explicit missing coverage matter:
  https://arxiv.org/abs/2211.09110
- MT-Bench / Chatbot Arena shows why judge reports need bias controls and
  preference-agreement checks:
  https://arxiv.org/abs/2306.05685
- G-Eval shows why rubric-based generation scoring needs form-filled judgments
  and external agreement checks:
  https://arxiv.org/abs/2303.16634
- OpenTelemetry GenAI semantic conventions are the interoperability target for
  trace and metric fields:
  https://opentelemetry.io/docs/specs/semconv/gen-ai/

## Next External Proof

Generate `reports/benchmarks/provider-matrix.json` and the companion raw output
files from a locked run. When those files contain every required lane and field,
the `benchmarking-infra` requirement can move from
`needs_public_benchmark_data` to `implemented`.
