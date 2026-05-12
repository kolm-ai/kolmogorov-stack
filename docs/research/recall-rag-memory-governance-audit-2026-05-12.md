# Recall RAG Memory Governance Audit

Date: 2026-05-12

Scope: local review of hosted Recall routes, qmd bridge, multimodal sidecar tokenizer, compile-time recall stage, artifact index slot, local `kolm rag` commands, assistant/memory routes, public Recall/API/docs/security/whitepaper pages, and tests.

## Executive Findings

1. P0: compile-time Recall is mostly metadata today. `src/compile.js` queries recall chunks when `corpus_namespace` is set, but those chunks are not passed into synthesis, eval generation, or artifact packaging. The artifact receives a recall namespace in the manifest, not a populated retrieval index.
2. P0: local `kolm rag attach` does not currently make `lib.rag` available to artifact recipes. `src/rag.js` defines `ragLibFor`, but `runArtifact` calls recipe code with `pack`, `index`, and `params`; source search found no runner integration for `ragLibFor`.
3. P1: `kolm compile --data` sends a local absolute path to hosted `/v1/embed`. The route only supports paths mounted on the server under the tenant recall root, so ordinary SaaS CLI usage can fail and continue without a corpus.
4. P1: public Recall copy overstates implementation. Pages describe embedded recall inside every signed artifact, bge-m3, CLIP, Whisper, CLAP, vector/RRF/rerank, and sqlite-vec, while current code is qmd-backed when available, placeholder multimodal sidecars otherwise, and pure local BM25 for `kolm rag`.
5. P1: recall source preview needs hardening. `/v1/recall/sources/:id(*)` returns absolute sidecar paths plus 4 KB previews and uses a string prefix check that is less strict than the `/v1/embed` tenant-root check.
6. P1: there is no recall/RAG test coverage. Existing root tests do not cover `/v1/recall`, `/v1/embed`, qmd-unavailable behavior, local `kolm rag`, artifact index packaging, `lib.rag`, source preview boundaries, or compile grounding.

## Current Modes

| Mode | Source | Current Truth |
| --- | --- | --- |
| Hosted `/v1/embed` | `src/router.js`, `src/recall.js`, `services/embed/multimodal.js`, `services/index/qmd.js` | Tokenizes server-mounted absolute paths, writes sidecars next to source files, then registers/embeds with qmd if available. |
| Hosted `/v1/recall` | `src/router.js`, `src/recall.js` | Queries qmd namespace after tenant-prefixing; qmd failures degrade to empty results. |
| Compile `corpus_namespace` | `src/compile.js`, `src/artifact.js` | Queries chunks and records stage count, but package receives only `recall_namespace`; no index is embedded unless an explicit `index` argument is passed by another path. |
| Verified wrap grounding | `src/router.js` | `POST /v1/wrap/verified` prepends recall snippets into the system prompt when chunks are found. |
| Local `kolm rag` | `src/rag.js`, `cli/kolm.js`, `docs/RAG.md` | Builds deterministic BM25 JSON indexes under `~/.kolm/rag/<name>` and can query them locally. |
| Local artifact attach | `src/rag.js`, `cli/kolm.js` | Writes `<artifact>.rag.json` sidecar, but current artifact runner does not load it into `lib.rag`. |
| Memory recall route | `src/router.js` | `POST /v1/memory/recall` searches registered concepts by query/tag and runs matching concepts; it does not query the recall corpus. |

## What Is Solid

- Recall HTTP routes are behind the authenticated `/v1` boundary.
- Non-admin `/v1/embed` paths must be absolute and under the tenant's `KOLM_RECALL_ROOT/<tenant>` slice.
- Recall namespaces are prefixed with a sanitized tenant and namespace before qmd sees them.
- `/v1/recall/status` exposes whether qmd is available and can return namespace status.
- Local `src/rag.js` parses and imports successfully; the BM25 index/query code is a real local implementation.
- The artifact `index.sqlite-vec` slot can carry an optional `KOLMIDX` JSON lookup container and decodes empty slots safely.

## Gaps To Fix

### Compile Grounding

The compile job records `recall.start` and `recall.done`, but the retrieved chunks are not used to shape the synthesized source, eval cases, K-score, receipt, or artifact index. This makes `corpus_namespace` useful as a stage marker, not as proof that the artifact is grounded in the corpus.

Minimum fix: feed chunks into synthesis/eval generation, record chunk hashes, and either embed a `KOLMIDX`/sqlite-vec payload or explicitly label the artifact as externally grounded.

### Local RAG Runtime

`docs/RAG.md` and CLI help say attached artifacts expose `lib.rag.query`. Current recipe execution gets `lib.pack`, `lib.index`, and `lib.params`, not `lib.rag`. There are no tests proving a recipe can call `lib.rag.query` after `kolm rag attach`.

Minimum fix: load `.rag.json` sidecars in `runArtifact`, expose a safe `lib.rag`, and add an end-to-end fixture recipe that requires it.

### Hosted Data Path

`kolm compile --data ./docs` calls hosted `/v1/embed` with the caller's absolute local path. The API route only supports paths that exist on the server. That is valid for self-hosted or mounted-corpus deployments, but not for ordinary remote SaaS usage.

Minimum fix: make `--data` require a local/offline compile mode or upload/archive flow, and make hosted failures explicit instead of quietly compiling without corpus.

### Multimodal And Vector Claims

Public pages claim bge-m3, CLIP, Whisper/CLAP, RRF, cross-encoder rerank, and sqlite-vec. The code delegates search to qmd if present, has placeholder or Anthropic image captioning for multimodal sidecars, and does not list qmd/pdf/vector dependencies in `package.json`.

Minimum fix: publish a mode table: shipped local BM25, preview qmd bridge, placeholder multimodal sidecars, roadmap local vector/sqlite-vec.

### Source Preview And Retention

`/v1/recall/sources/:id(*)` returns the absolute sidecar path and a 4 KB preview. It checks `full.startsWith(lookupRoot)`, while `/v1/embed` uses a stricter tenant-root plus separator check. Recall has no purge, retention, namespace delete, encryption, or audit events.

Minimum fix: normalize with a separator-aware containment helper, avoid returning absolute paths to tenants, cap reads before loading the whole sidecar, and add deletion/retention controls.

## Release-Blocking Tests

- `/v1/embed` rejects paths outside tenant root, including sibling-prefix paths, and returns the documented response shape.
- `/v1/recall` reports qmd unavailable distinctly from an empty result set.
- `kolm compile --data` has a tested hosted failure path and a tested self-hosted/mounted success path.
- Compile with recall chunks proves those chunks influence synthesis/evals or explicitly marks them unused.
- `kolm rag index/query/attach` has a fixture test.
- An attached artifact can call `lib.rag.query` during `runArtifact`.
- Artifact packaging tests prove when `index.sqlite-vec` is empty, `KOLMIDX`, or sqlite-vec roadmap.
- `/v1/recall/sources` cannot escape tenant root and does not leak absolute paths.

## Decision

Treat Recall as three separate surfaces until the contracts are unified:

- `hosted-recall-preview`: server-mounted qmd bridge for self-hosted or controlled deployments.
- `local-rag-bm25`: local pure-JS BM25 index/query, currently usable as CLI storage/query.
- `artifact-bound-recall`: not shipped end to end until compile embeds/indexes corpus evidence and the runner exposes a tested retrieval API.

See `recall-rag-memory-governance-matrix-2026-05-12.csv` for row-level evidence and actions.
