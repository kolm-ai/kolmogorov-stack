---
title: kolm rag · kolm.ai
description: Airgapped local retrieval (BM25, no embedder, no network).
---

# kolm rag

> Airgapped local retrieval. BM25 only. No embedder. No network. Recipes attach an index and query it through `lib.rag.query(q, k)`.

## Usage

```bash
kolm rag index <dir> [--name <slug>] [--ext txt,md,json] [--max-bytes 4194304]
kolm rag query <name> "<question>" [--top-k 5] [--json]
kolm rag attach <art.kolm> --index <name>
kolm rag list
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--name <slug>` | dir basename | index name |
| `--ext <list>` | `txt,md,json` | comma-separated file extensions to ingest |
| `--max-bytes <n>` | `4194304` (4 MiB) | per-file size cap |
| `--top-k <n>` | `5` | how many hits to return |
| `--json` | off | machine-readable output |
| `--index <name>` | required for attach | which index to bind to the artifact |

## Examples

```bash
kolm rag index ./docs --name internal-docs
kolm rag query internal-docs "how does the K-score gate work" --top-k 3
kolm rag attach ./artifacts/help-bot.kolm --index internal-docs
kolm rag list
```

## Notes

Inside a recipe:

```javascript
function generate(input, lib) {
 var hits = lib.rag ? lib.rag.query(input.q, 3).matches : [];
 // ...
}
```

The runtime exposes `lib.rag.query(q, k)` only to recipes that have been attached to an index. Indexes are stored in `~/.kolm/rag/<name>/`.

## See also

- [Quickstart](/quickstart)
- [API reference](/docs/api)
- [kolm compile](/docs/cli/compile)
