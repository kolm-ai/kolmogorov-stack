# Benchmark Reproducibility Audit - 2026-05-12

## Scope

This pass compares the public benchmark and K-score claims against the local fixture artifacts, benchmark harness, compile paths, SWE-bench reproducer, tests, and supporting benchmark docs.

Reviewed local sources:

- `public/benchmarks.html`
- `public/k-score.html`
- `public/articles/how-we-benchmark.html`
- `docs/benchmark-results-v0.1.0.md`
- `docs/PRODUCT.md`
- `src/benchmark.js`
- `src/artifact.js`
- `src/compile.js`
- `src/spec-compile.js`
- `src/synthesis.js`
- `services/mcp/server.js`
- `bench/README.md`
- `bench/run.py`
- `test/fixtures/*.kolm`
- `test/fixtures/sample-bench.json`
- `tests/artifact-end-to-end.test.js`
- `tests/server.test.js`
- `scripts/smoke-bench-cli.mjs`

## Executive Findings

The artifact-local benchmark path is real. A local smoke run on the four checked-in fixtures returned the expected bytes, eval counts, manifest K-score values, zero egress attempts, and valid signatures for `sample`, `redactor`, `extractor`, and `classifier`. The root test suite also includes artifact benchmark shape coverage and fixture e2e coverage.

The public benchmark story is still too broad for the implementation. `/benchmarks` is artifact-local, while `/articles/how-we-benchmark` and `kolm bench --reproduce` are a separate SWE-bench/Opus story. The artifact benchmark page uses "95% CI" in metadata even though `src/benchmark.js` does not compute confidence intervals. The SWE-bench reproducer contains CI code, but the shipped `bench/run.py` evaluator stub returns `False` for every patch and points to an external full implementation for the actual harness.

The "no eval, no ship" and "bad artifact never written" claims are not globally true. `src/synthesis.js` enforces a quality gate for generated candidates, but `src/spec-compile.js` accepts specs with no eval cases, supplies default perfect training stats, and calls `buildAndZip`. `src/artifact.js` computes `k_score.ships` but does not block the final write when the score is below the gate.

K-score semantics are split across generations. Current `src/artifact.js` implements `k-score-1` as a 0..1 weighted composite with `ships` and `gate`. The checked-in fixtures and `sample-bench.json` still carry legacy hundreds-scale composites such as `424.57`. Public pages use both the hundreds-scale fixture table and the 0.85 gate language, which can confuse CI policies and buyer proof.

The reference benchmark evidence is not yet canonical. `docs/benchmark-results-v0.1.0.md`, `test/fixtures/sample-bench.json`, and `/benchmarks` publish different sample latency values. That may be acceptable because latency varies by machine, but only one machine-readable reference report exists and it covers only `sample.kolm`, not the four-row fixture table.

The egress monitor is useful but narrower than the sovereignty language implies. `src/benchmark.js` patches `fetch`, `http`, `https`, `net`, `tls`, and `dns` inside the Node process during recipe execution. That proves these fixture recipes did not use those APIs during the benchmark. It is not an OS-level network sandbox and should not be described as a universal egress proof for arbitrary untrusted artifacts.

## Local Smoke Result

Command shape used:

```powershell
$env:RECIPE_RECEIPT_SECRET='kolm-public-fixture-v0-1-0'
node --input-type=module -e "import { benchmarkArtifact } from './src/benchmark.js'; ..."
```

Observed one-run summary:

| Fixture | Bytes | Evals | Passed | K-score | Egress | Signature |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `sample.kolm` | 3259 | 4 | 4 | 424.57 | 0 | true |
| `redactor.kolm` | 4933 | 6 | 6 | 362.96 | 0 | true |
| `extractor.kolm` | 4571 | 5 | 5 | 373.48 | 0 | true |
| `classifier.kolm` | 4649 | 5 | 5 | 371.00 | 0 | true |

This supports the fixture-level artifact benchmark path. It does not support the SWE-bench headline or the full public K-score gate story.

## What Is Solid

- `test/fixtures/*.kolm` exist and verify under `RECIPE_RECEIPT_SECRET=kolm-public-fixture-v0-1-0`.
- `tests/artifact-end-to-end.test.js` loads each fixture, verifies signatures, runs evals, benchmarks with zero egress, and checks receipt presence.
- `tests/server.test.js` builds a temporary artifact and verifies `kolm-benchmark-1` report shape, output writing, CLI alias behavior, and signature metadata.
- `src/benchmark.js` produces a compact JSON report with artifact hash, size, eval pass rate, latency percentiles, in-process egress attempts, signature state, and receipt chain length.
- `services/mcp/server.js` does implement `k_min` filtering for numeric K-scores below the configured threshold.

## What Needs Correction

1. Split artifact-local benchmark claims from SWE-bench reproducer claims. They need separate pages, headings, schemas, and evidence bundles.
2. Remove "95% CI" from artifact benchmark metadata unless `kolm-benchmark-1` reports confidence intervals.
3. Either make `compile --spec` require eval cases and enforce `k_score.ships`, or change "no eval, no ship" to "public fixture artifacts carry evals".
4. Rebuild fixtures or version the K-score schema so hundreds-scale fixture K-scores cannot be confused with the 0..1 `k-score-1` gate.
5. Publish canonical machine-readable benchmark reports for all four fixtures, including command, Node version, device label, artifact hash, and secret.
6. Replace or complete the local SWE-bench reproducer so a local Docker build can actually evaluate patches rather than producing a report with all patches unresolved.
7. Clarify egress language: "Node API egress monitor during benchmark" is accurate; "sovereign binary proof" needs a stronger sandbox story.

## Decision

Treat the current benchmark assets as a credible fixture smoke, not as finished buyer-grade benchmark evidence. The next release should gate public benchmark copy on generated report artifacts, a single K-score schema, and tests that fail when `/benchmarks`, fixture metadata, and benchmark JSON disagree.

