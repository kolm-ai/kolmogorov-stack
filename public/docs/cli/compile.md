---
title: kolm compile · kolm.ai
description: Build a .kolm artifact from a cloud-synthesised task or a local JSON spec.
---

# kolm compile

> Build a .kolm artifact. Cloud-synthesised from a task description, or fully offline from a JSON spec.

## Usage

```bash
kolm compile "<task>" [flags] # cloud compile
kolm compile --spec <file.json> [--out <p>] # offline build from a JSON spec
kolm compile --spec - [--out <p>] # offline build from JSON on stdin
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--data <dir>` | none | corpus dir that grounds the cloud compile (Recall) |
| `--base-model <name>` | `Qwen/Qwen2.5-3B-Instruct` | base model embedded in the manifest |
| `--examples <file.jsonl>` | none | seed examples for the verifier |
| `--out <dir|file.kolm>` | `~/.kolm/artifacts` | where the artifact lands |
| `--deploy-hook <https-url>` | `$KOLM_DEPLOY_HOOK_URL` | POST `{job_id, artifact_url, k_score, ...}` after a green compile |
| `--spec <file|->` | none | offline path: JSON spec on disk or stdin |
| `--gate <n>` | `0.85` | K-score gate floor. Exit 2 means gate failed but the artifact is still on disk |
| `--k-min <n>` | `0.0` | per-axis floor on the K-score axes (A/S/L/C/V/T) |
| `--gate-cve-policy <slug>` | `balanced` | `strict` | `balanced` | `permissive` CVE-policy class |
| `--gate-stability <n>` | `0.0` | per-axis floor on the K-score Stability axis |
| `--gate-latency-budget <ms>` | none | reject the artifact when measured p95 exceeds this budget |
| `--license <id|@path>` | `LicenseRef-kolm-default-1.0` | SPDX id, custom LicenseRef, or `@path/to/license.json` |
| `--tokenizer <file>` | none | bundle `tokenizer.json` inside the artifact |
| `--distill-provenance <dir>` | none | bind a `workers/distill` output dir as lineage |
| `--export-provenance <dir>` | none | bind an `apps/export` output dir as exported targets |
| `--export <backend>` | none | shortcut: bundle one already-built file/dir. `gguf|onnx|safetensors|coreml|mlx|executorch|tensorrt` |
| `--export-from <path>` | none | path to the file/dir bundled by `--export` |
| `--moe-provenance <dir>` | none | bind a Mixture-of-Experts composition |
| `--pretokenize-provenance <dir>` | none | bind a pretokenize output dir (KOLMIDX2 + KOLMPCK2) |
| `--external-holdout <name>` | none | score recipe against a public benchmark holdout. Repeatable |
| `--adversarial-holdout <name>` | none | score against an adversarial paraphrase holdout. Repeatable |
| `--tenant-shadow-corpus <tid>:<cid>` | none | score against a tenant-private corpus that never leaves tenant storage |
| `--auditor-attestation <file>` | none | bind a third-party auditor's Ed25519-signed attestation. Repeatable |

## Examples

```bash
# cloud compile (requires kolm login)
kolm compile "triage support tickets" --data ./tickets --examples ./labels.jsonl

# offline: write a spec, compile, run locally
kolm new my-classifier --from classifier
kolm compile --spec my-classifier.spec.json --out my-classifier.kolm
kolm run my-classifier.kolm '{"text":"refund my last invoice"}'

# offline from stdin (AI-agent friendly)
cat spec.json | kolm compile --spec - --out out.kolm

# strict gate + per-axis floor
kolm compile --spec phi.spec.json --gate 0.95 --k-min 0.85 --gate-cve-policy strict
```

## Notes

The spec path signs the artifact with a per-user secret stored at `~/.kolm/config.json` (auto-generated). Set `RECIPE_RECEIPT_SECRET` in env to share signatures across teammates / CI.

Recipes run inside a frozen `node:vm` sandbox. The compiler scans `recipes[].source` for forbidden identifiers (`process`, `require`, `module`, `global`, `globalThis`, `__dirname`, `__filename`, `import(`, `Function(`, `eval(`, `constructor`, `prototype`, `ArrayBuffer`, `SharedArrayBuffer`, `Atomics`, `Reflect`, `Proxy`, `WeakRef`, `FinalizationRegistry`, `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask`). Recipes operate on the frozen `lib` argument only - no Node, no DOM, no network.

By default every successful compile also emits a `SKILL.md` sidecar next to the artifact (Claude Code's frontmatter format). Pass `--no-skill` to suppress.

## See also

- [Quickstart](/quickstart)
- [API reference](/docs/api)
- [kolm verify](/docs/cli/verify) for the post-compile audit
- [kolm run](/docs/cli/run) to execute the artifact
- [Troubleshooting](/docs/troubleshooting) when the gate fails
