# vLLM .kolm model loader

STATUS: DRAFT, 2026-05-24

This directory holds the scaffolding for a vLLM model loader that accepts
`kolm://` URIs and points the existing HuggingFace-style loader at the
unpacked weights. It is a draft; nothing here is wired into vLLM yet.

## Goal

Make this work:

```
vllm serve kolm://sha256-abc123... --tensor-parallel-size 4
python -m vllm.entrypoints.openai.api_server --model kolm://sha256-abc123...
```

vLLM today expects either a HuggingFace repo id or a local path with a
`config.json` next to the weights. The loader proposed here extends
vLLM's `ModelRegistry` with a `kolm://` scheme handler that:

1. Resolves the URI against `~/.kolm/artifacts/`.
2. Extracts `weights.bin` (or the sharded files declared in the
   manifest) to a staging directory.
3. Translates the kolm manifest into the HF-style `config.json` +
   `tokenizer.json` + `generation_config.json` triple that vLLM's
   existing loader expects.
4. Hands the staging path back to vLLM's standard loader.

The kolm-specific work happens once at startup; everything after the
hand-off is vLLM proper. There is no per-request kolm code path.

## Implementation

The loader is a thin Python package, `vllm_kolm`, that registers a
URI scheme via vLLM's loader plugin hook (added in vLLM 0.6.x). The
package depends on the kolm Python SDK (`pip install kolm`) for
signature verification and pull, then writes the HF-style triple to a
scratch directory that vLLM is told to use as the model path.

Wraps:

- `weights.bin` extraction via the kolm SDK's `ArtifactReader`.
- Manifest -> HF config translation (table below).
- HF tokenizer reconstruction from the manifest's tokenizer block.
- Optional re-shard if the operator requests a different tensor
  parallel size than the artifact was originally sharded for.

| .kolm manifest field            | HF config.json field             | Notes                                                  |
| ------------------------------- | -------------------------------- | ------------------------------------------------------ |
| `manifest.base_model`           | `_name_or_path`                  | lineage breadcrumb                                     |
| `manifest.architecture`         | `model_type`                     | e.g. `llama`, `qwen2`, `mistral`                       |
| `manifest.hidden_size`          | `hidden_size`                    | dim of residual stream                                 |
| `manifest.num_layers`           | `num_hidden_layers`              |                                                        |
| `manifest.num_heads`            | `num_attention_heads`            |                                                        |
| `manifest.num_kv_heads`         | `num_key_value_heads`            | for GQA / MQA                                          |
| `manifest.vocab_size`           | `vocab_size`                     |                                                        |
| `manifest.context_window`       | `max_position_embeddings`        |                                                        |
| `manifest.rope_theta`           | `rope_theta`                     | absent -> HF default                                   |
| `manifest.tokenizer.kind`       | `tokenizer_class`                | mapped: `bpe` -> `LlamaTokenizer`, etc.                |
| `manifest.bos_token_id`         | `bos_token_id`                   |                                                        |
| `manifest.eos_token_id[]`       | `eos_token_id`                   | int or list per HF convention                          |
| `manifest.quantization.kind`    | `quantization_config.quant_method` | passed through; vLLM handles awq/gptq/bitsandbytes natively |
| `manifest.quantization.bits`    | `quantization_config.bits`       |                                                        |

Anything else in the manifest (attestation, K-Score, lineage receipts,
routing hints, kolm-specific provenance) is preserved on disk for the
kolm CLI but does not enter the vLLM config.

## Tensor parallel mapping

The artifact records its original shard layout in
`manifest.shards[].rank` and `manifest.shards[].tp_size`. The loader
honours `--tensor-parallel-size` from the vLLM command line:

- If `--tp == manifest.shards[0].tp_size`: copy shards through
  unchanged. Fastest path.
- If `--tp != manifest.shards[0].tp_size`: re-shard via the kolm
  SDK's `reshard_for_tp(target_tp)` helper, which loads the full
  tensors into a single CPU buffer and re-splits per the new tp
  dimension. Slow (minutes for 70B+ models) but correct.
- If `--tp` is unsupported by the model architecture (e.g. asking
  for tp=3 on an attention head count that doesn't divide evenly):
  the loader fails loud at startup with the divisibility hint, never
  silently rounds.

## Hot-reload on artifact update (W824 rolling-update support)

When the kolm autopilot writes a new `.kolm` to the local registry,
the loader can swap weights without a vLLM process restart:

1. The kolm CLI emits a `kolm:artifact-updated` event on its IPC
   socket (`~/.kolm/run/events.sock`).
2. The loader subscribes; on event, it stages the new artifact in a
   sibling directory.
3. It signals vLLM via the `/v1/admin/reload-weights` route (added
   in vLLM 0.7+ for LoRA hot-swap) and points it at the new path.
4. If the swap fails (shape mismatch, tokenizer drift, GPU OOM),
   the loader keeps serving the old weights and emits a `swap_failed`
   event back to kolm so the autopilot can refuse to retire the old
   artifact.

The rolling-update path is tracked under wave W824 and is opt-in
behind a `KOLM_VLLM_HOT_RELOAD=1` environment flag in this draft.

## Honest status

- Plugin not yet implemented.
- vLLM 0.6.x plugin ABI is the target; 0.5.x and earlier need the
  two-step `kolm unpack` + `vllm serve <path>` workaround.
- The re-shard path is correct but slow; a faster online re-shard
  is on the wishlist but not required for v1.
- Multi-modal artifacts (vision-language, audio) are out of scope
  for v1. vLLM's multi-modal handling is still consolidating
  upstream.
