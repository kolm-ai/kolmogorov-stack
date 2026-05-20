---
title: kolm serve · kolm.ai
description: Expose .kolm artifacts as MCP tools or as an OpenAI-compatible HTTP server.
---

# kolm serve

> Expose .kolm artifacts as MCP tools, or run one generative artifact as an OpenAI-compatible HTTP endpoint.

## Usage

```bash
kolm serve --mcp [--port <n>] # frontier-agent transport
kolm serve --http <art.kolm> [--port <n>] [--host H] # OpenAI-compatible HTTP
```

## Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--mcp` | off | every artifact in `~/.kolm/artifacts/` becomes a tool Claude Code / Cursor / Continue can call. Microsecond pattern-match execution. No GPU needed |
| `--http <art.kolm>` | none | one generative artifact serves an OpenAI-compatible `/v1/chat/completions` endpoint via vLLM (preferred) or transformers |
| `--port <n>` | `8765` (http) | listen port |
| `--host <h>` | `127.0.0.1` | bind address |

## Examples

```bash
kolm serve --mcp # what Claude Code sees
kolm serve --http job_foo.kolm --port 8765 # local OpenAI server
KOLM_FORCE_TRANSFORMERS=1 kolm serve --http foo.kolm # skip vLLM, use HF only
```

## Environment

| Env var | Description |
| ------- | ----------- |
| `KOLM_MAX_MODEL_LEN` | vLLM `max_model_len` (default `8192`) |
| `KOLM_NUM_SPECULATIVE_TOKENS` | vLLM speculative tokens (default `5`) |
| `KOLM_FORCE_TRANSFORMERS` | set to `1` to prefer `transformers.generate()` over vLLM |
| `KOLM_LORA_DIR` | where to extract LoRA packs (default `~/.kolm/lora`) |

## Notes

The MCP mode is preferred for agent harnesses (Claude Code, Cursor, Cline, Continue). The HTTP mode is preferred when an existing OpenAI client needs a drop-in endpoint. Speculative decoding uses the artifact's declared draft model; FP8 KV cache is used on Hopper / Blackwell; AWQ / GPTQ weights work when the artifact's base model is already quantized.

## See also

- [Quickstart](/quickstart)
- [kolm install](/docs/cli/install)
- [API reference](/docs/api)
- [Runtime guide](/docs/runtime)
