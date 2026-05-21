---
title: kolm rag - kolm.ai
description: Build and query air-gapped local retrieval indexes for Kolm recipes.
---

# kolm rag

Build and query air-gapped local retrieval indexes. Kolm RAG uses BM25 only, has no embedder, and does not require network access.

## Usage

```bash
kolm rag index <dir> [--name <slug>] [--ext txt,md,json] [--max-bytes 4194304]
kolm rag query <name> "<question>" [--top-k 5] [--json]
kolm rag attach <artifact.kolm> --index <name>
kolm rag list
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--name <slug>` | directory name | Index name. |
| `--ext <list>` | `txt,md,json` | Comma-separated file extensions to ingest. |
| `--max-bytes <n>` | `4194304` | Per-file size cap. |
| `--top-k <n>` | `5` | Number of hits returned by query. |
| `--json` | off | Emit machine-readable query output. |
| `--index <name>` | required for attach | Bind an existing index to an artifact. |

## Runtime Contract

Recipes attached to an index can call `lib.rag.query(q, k)` during local execution. Indexes are stored under `~/.kolm/rag/<name>/` and stay local unless the operator explicitly moves the artifact and index.

## Example

```bash
kolm rag index ./docs --name internal-docs
kolm rag query internal-docs "how does the K-score gate work" --top-k 3
kolm rag attach ./artifacts/help-bot.kolm --index internal-docs
```
