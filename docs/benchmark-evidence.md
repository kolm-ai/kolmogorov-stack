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

The local contract verifies that the current sample benchmark report
(`public/benchmarks/trinity-500-benchmark.json`), benchmark evidence docs,
lock-in tests, artifact comparison harness, and compare module exist and parse.
The public-claim gate stays closed until `reports/benchmarks/` contains complete
provider lanes for:

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
- a `publication` packet with HTTPS leaderboard URL, dataset manifest path,
  signed raw-output bundle path, hardware/provider manifest path, harness
  configuration manifest path, statistical analysis path, contamination report
  path, leaderboard stability path, reproducer command, matching reproducer
  command SHA-256, and freshness expiration

The audit only marks `public_claim_ready` when the provider matrix validates and
the lane report paths plus every publication packet file exist under
`reports/benchmarks/`. A complete-looking lane table is not enough to promote
the `benchmarking-infra` gate.

```bash
node scripts/benchmark-evidence.mjs --template
node scripts/benchmark-evidence.mjs --validate reports/benchmarks/provider-matrix.json
node scripts/bench-compare.mjs --matrix reports/benchmarks/provider-matrix.json --public
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
- LiveBench is the contamination/freshness baseline: public benchmark packets
  must include task provenance, freshness windows, and objective scoring where
  possible:
  https://arxiv.org/abs/2406.19314
- Chatbot Arena is the pairwise-preference statistics baseline: leaderboards
  need uncertainty and agreement reporting, not only a single rank:
  https://arxiv.org/abs/2403.04132
- Leaderboard stability work shows close rankings can be fragile; public claims
  need robustness and manipulation/stability analysis:
  https://arxiv.org/abs/2605.15761
- Harness-Bench shows agent benchmark results belong to a model plus harness
  configuration, so public rows must identify tool/runtime constraints and
  recovery behavior:
  https://arxiv.org/abs/2605.27922

## Next External Proof

Generate `reports/benchmarks/provider-matrix.json` and the companion raw output
files from a locked run. Include `dataset-manifest.json`,
`raw-output-bundle.json`, `hardware-providers.json`, `harness-configs.json`,
`statistical-analysis.json`, `contamination-report.json`, and
`leaderboard-stability.json`. When those files contain every required lane and
field, the `benchmarking-infra` requirement can move from
`needs_public_benchmark_data` to `implemented`.
