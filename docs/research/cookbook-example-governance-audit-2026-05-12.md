# Cookbook Example Governance Audit - 2026-05-12

## Executive Summary

The live and local cookbook is a high-conviction buyer proof surface, not just documentation. It says there are "30 recipes" and that they "all compile"; detail pages add `.toml` compile commands, K-score floors, realized K-scores, artifact sizes, compile times, device latency profiles, offline behavior, and signed receipt claims.

The implementation evidence does not yet support that surface. The repo has four verified public `.kolm` fixture artifacts (`sample`, `redactor`, `extractor`, `classifier`) and 26 small public JSON synthesis examples. It does not have the cookbook `.toml` specs, JSONL gold sets, generated `.kolm` outputs, per-page benchmark reports, or command smoke tests needed to prove the 30-recipe cookbook.

This is a product-truth issue because the cookbook is the natural place a buyer will go to ask "show me it works for my domain." Today, the answer is strong for the four fixture artifacts, weak for the 30 cookbook pages, and especially weak for regulated vertical examples.

## Primary Evidence

- Live `https://kolm.ai/cookbook` returned HTTP 200 and contains the same headline claim as local `public/cookbook.html`: "30 recipes" and "All compile."
- Local `public/cookbook/` contains 33 HTML detail pages, while the index links 30 of them. The unlinked pages are `drug-name-redact`, `intake-triage`, and `tactical-edge-intel`.
- All 33 cookbook detail pages include `--output` in their compile snippets. Current `cli/kolm.js` accepts `--out`, not `--output`, in both spec and cloud compile paths.
- The cookbook pages reference many `.toml`, `.jsonl`, `.json`, and `.kolm` files that are not present in the repo outside the four public fixtures.
- Current CLI dispatch has no `spec` command and no `artifact` command, but cookbook copy references `kolm spec --check` and several pages use `kolm artifact` wording.
- `kolm run` accepts positional input plus `--params`; it does not implement `--input-file` or `--input-stdin`. Several cookbook snippets use those flags.
- A direct run probe with `--input` showed the flag is treated as positional input, not as an input flag. The sample artifact returned an empty uppercase result because the input string became `--input`.
- `tests/artifact-end-to-end.test.js` is real and valuable: it loads, verifies, evaluates, benchmarks, and exercises the four public fixtures.
- The four public fixtures are tiny recipe-tier artifacts: about 3.2 KB to 4.9 KB on disk. Their local K-score CLI output is in the hundreds (`424.57`, `362.96`, `373.48`, `371`) because the implementation scale is not the cookbook scale.
- Cookbook pages publish K-scores around `0.81` to `0.94`, artifact sizes from tens of MB to multiple GB, and device latency profiles. No per-page artifact or benchmark report was found to back those numbers.
- `examples/*.json` contains 26 public examples with 3 to 12 positive rows each. These are seed synthesis examples, not compiled cookbook artifacts.
- `scripts/build-all-examples.mjs` explicitly builds only four fixtures. That builder and the three concrete builder scripts pass `node --check`.
- The legacy demo runbook still contains stale public-demo framing, old brand language, stale package import guidance, and old deployment host guidance. It should not be treated as a current proof script.

## What Is Solid

The four fixture artifacts are the strongest proof in this slice. They have deterministic builder scripts, fixture files, signatures, embedded evals, benchmark assertions, tenant-params behavior, tamper rejection, and a dedicated end-to-end test.

The 26 JSON examples are also real seed material. They are valid JSON, publicly tagged, and cover common classifier/extractor/counter shapes. They should be positioned as seed examples unless and until they compile into artifacts with receipts and benchmark evidence.

## Main Gaps

The cookbook conflates three categories:

1. Verified fixture artifacts.
2. Small synthesis seed examples.
3. Aspirational worked recipes for domains and devices.

The public UI presents category 3 as category 1. That creates avoidable trust risk: a developer can copy commands that do not work, and a regulated buyer can see HIPAA, finance, legal, or defense examples without downloadable artifacts, eval sets, or receipt evidence.

Command drift is the most immediate fix. If the cookbook remains live, every command in every page should be generated from CLI help or tested as a static fixture. Today, `--output`, `--input-file`, `--input-stdin`, `kolm spec --check`, and `kolm artifact` are not aligned with current dispatch.

Metrics drift is the next fix. Public K-score values are normalized fractions; local artifacts report large composites. That can be explained as a schema migration, but it cannot be left implicit on proof pages.

## Recommended Policy

Create a `cookbook-proofs.json` manifest and generate the cookbook from it. Each recipe row should declare:

- status: `verified`, `seed`, `preview`, or `target`.
- command_contract: exact CLI command and expected exit code.
- source_files: spec, examples, verifier, and artifact path.
- artifact: size, hash, receipt algorithm, and K-score schema.
- benchmark: device, runs, p50/p95, egress attempts, and report path.
- compliance_label: regulated examples must include a proof note or be marked as illustrative.

Do not label a page "compileable" unless its compile command has a passing smoke test and its referenced files exist in the repo or as downloadable signed artifacts.

## Buyer Impact

The cookbook can become the best credibility asset in the product if it is converted from hand-written claim pages into generated proof pages. The fastest credible launch path is not 30 pages. It is 8 to 12 verified recipes with real specs, evals, artifacts, receipts, and benchmark reports, plus the remaining pages marked as preview patterns.

