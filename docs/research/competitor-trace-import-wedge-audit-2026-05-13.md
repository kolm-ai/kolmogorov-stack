# Competitor Trace Import Wedge Audit

Date: 2026-05-13

Scope: official docs for gateway, observability, eval, fine-tuning, and platform surfaces that can either feed Kolm artifacts or route traffic to Kolm; local Kolm capture/import/router/CLI code truth; next integration priority.

## Executive Summary

Competitor research keeps pointing to the same product move: Kolm should not build another trace dashboard, eval UI, gateway, or fine-tuning console. Those surfaces already exist and have usable data-export or middleware hooks. Kolm should build the importer, schema, artifact compiler, receipt, and route-back layer that turns those traces into verifiable `.kolm` artifacts.

Official docs confirm near-term input surfaces:

- Langfuse exposes project APIs, SDK query methods for traces, observations, scores, datasets, and scheduled/manual export paths.
- LangSmith exposes SDK trace queries and bulk Parquet export to S3-compatible storage, with run fields including inputs, outputs, tags, costs, and trace hierarchy.
- Braintrust exposes APIs for datasets, experiments, logs, prompts, scorers, and BTQL queries over traces.
- Helicone exposes datasets, request query APIs, an export CLI, JSONL/CSV formats, and fine-tuning/eval dataset workflows.
- Phoenix exposes import/export trace workflows, CLI trace export, REST APIs for datasets/traces, and OTLP/OpenInference trace collection.
- W&B Weave exposes evaluation datasets/runs and a REST API for exporting predictions, resolved inputs, scores, and row digests.
- OpenPipe explicitly captures logs, exports datasets as JSONL, fine-tunes replacements, and hosts the resulting model behind an OpenAI-compatible format.
- Predibase owns the hosted adapter path: upload dataset, train adapter, evaluate, deploy, and serve LoRA adapters from a deployment.
- LiteLLM exposes custom callbacks, proxy hooks, custom providers, and request/response logging hooks.
- Vercel AI SDK exposes `wrapLanguageModel` middleware.
- Cloudflare AI Gateway now supports custom providers with OpenAI-compatible or provider-specific routing.
- Portkey supports private/self-hosted provider routing through virtual/provider keys.

Local Kolm has a useful but narrow foundation: OpenAI/Anthropic capture proxy endpoints, an observations table, suggestions, auto-synthesis from clustered observations, and `kolm labels` export from captured pairs. It does not yet have a `kolm import` command, external trace connectors, a canonical trace/eval interchange schema, importer fixtures, middleware packages, or receipt write-back into competitor systems.

The priority should be:

1. Langfuse importer: strongest open-source/self-hosted observability wedge with traces, observations, datasets, scores, and exports.
2. Helicone importer plus LiteLLM callback: fastest gateway/log path from real production requests to JSONL.
3. LangSmith and Braintrust importers: enterprise/eval workflow credibility, especially for datasets and scorer-backed gates.
4. Vercel AI SDK middleware: artifact-first routing inside Next.js/AI SDK apps.
5. Cloudflare/Portkey custom-provider route: OpenAI-compatible Kolm runtime as a target, only after runtime trust and sandbox gating are clearer.
6. OpenPipe/Predibase comparisons: treat them as the "trace to fine-tuned hosted replacement" benchmark; Kolm must prove portability, receipts, and governance rather than generic fine-tuning.

## Local Code Truth

Kolm already has:

- `kolm capture --provider <openai|anthropic>` to write capture configuration.
- `/v1/capture/openai` and `/v1/capture/anthropic` proxy endpoints that record request/response pairs into `observations`.
- `/v1/bridges/observations` and `/v1/bridges/suggestions` for captured observation review and clustering.
- `/v1/bridges/auto-synthesize` to synthesize from a cluster with at least four observations.
- `/v1/labels/synthesize-corpus` and `kolm labels` to export captured pairs as JSONL or JSON.
- `/v1/specialists/auto-distill` stubbed behind a trainer bridge and 1000-pair threshold.

Kolm does not yet have:

- `kolm import langfuse|langsmith|braintrust|helicone|phoenix|weave|openpipe`.
- A source-neutral trace/eval schema.
- Importer fixtures with real example payloads.
- Per-source redaction/consent gates.
- Deduplication rules across trace IDs, row digests, prompt hashes, and dataset versions.
- K-score mapping from external scores/rubrics into artifact eval cases.
- Write-back of artifact IDs, K-scores, receipts, or avoided-call metrics to source systems.
- Gateway middleware packages for LiteLLM, Vercel AI SDK, Cloudflare AI Gateway, or Portkey.

## Proposed Interchange Schema

Minimum `kolm-trace-1` row:

```json
{
  "source_system": "langfuse|langsmith|braintrust|helicone|phoenix|weave|openpipe|custom",
  "source_project": "string",
  "source_trace_id": "string",
  "source_span_id": "string",
  "source_dataset_id": "string",
  "source_dataset_version": "string",
  "task_name": "string",
  "input": {},
  "output": {},
  "expected": {},
  "scores": {},
  "prompt_ref": "string",
  "model": "string",
  "latency_ms": 0,
  "cost_usd": 0,
  "started_at": "2026-05-13T00:00:00Z",
  "tags": [],
  "metadata": {},
  "user_hash": "sha256",
  "session_hash": "sha256",
  "consent": { "training_allowed": false, "retention_days": 0 },
  "redaction": { "mode": "raw|redacted|hash-only", "policy": "string" }
}
```

That schema should convert to:

- eval cases for recipe-only artifacts,
- capture corpora for local tune,
- benchmark groups for avoided-call measurement,
- receipt source refs for lineage,
- source-system write-back metadata.

## Recommended First Proof

Build a Langfuse-to-Kolm fixture first:

1. Export or query a small set of Langfuse traces/observations with inputs, outputs, scores, tags, and model metadata.
2. Normalize to `kolm-trace-1`.
3. Convert high-confidence rows into a Kolm spec with eval cases.
4. Compile a recipe-only artifact.
5. Run `kolm eval` and `kolm bench`.
6. Emit a receipt bundle with original trace IDs, source dataset version, K-score, and avoided-call estimate.

Second proof: Helicone JSONL export to Kolm. It should be fast because Helicone already exposes request/response export paths and JSONL formats.

Third proof: Vercel AI SDK middleware that tries a local `.kolm` artifact first, emits a receipt, and falls back to the wrapped model.

## Positioning Implication

OpenPipe and Predibase already own much of the "logs to cheaper hosted model" story. Kolm must avoid arguing that it is simply cheaper model customization. The stronger claim is:

> Existing tools collect the evidence. Kolm turns accepted evidence into a signed, portable, governed task artifact and proves every run with receipts.

That claim is still not complete in code because importers and write-back do not exist yet. The work should move from public positioning to importer fixtures and route middleware.

## Validation Performed

- Reviewed official docs for Langfuse, LangSmith, Braintrust, Helicone, Phoenix, Weave, OpenPipe, Predibase, LiteLLM, Vercel AI SDK, Cloudflare AI Gateway, and Portkey.
- Reviewed local `cli/kolm.js`, `src/capture.js`, and `src/router.js` capture, label export, auto-synthesis, and distill paths.
- Searched local source for competitor-specific importers and middleware; no external trace importer command or package was found.
