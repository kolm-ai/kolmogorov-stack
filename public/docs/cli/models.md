# kolm models

Inspect the frontier catalog and pre-cache model weights from HuggingFace.
The command has two halves: catalog verbs (`list`, `info`, `recommend`, `pin`,
`devices`, `frontier`, `tiers`, `show`, `verify`) that read the local registry,
and weights verbs (`manifest`, `pull`, `prefetch`, `cache`) that stream GGUF
files into `~/.kolm/models`.

## Catalog

```
kolm models list local model registry
kolm models info <id> one-row inspection
kolm models recommend pick a model for this machine
kolm models pin <id> pin the active default
kolm models devices show registered devices for this row
kolm models frontier list verified frontier rows
kolm models tiers list hardware tier presets
kolm models show <id> per-row inspection (frontier)
kolm models verify re-fetch source URLs, fail on 4xx/5xx
```

## Weights

```
kolm models manifest [--tier=<t>] [--json] print the GGUF manifest
kolm models pull <id> [--variant=<q>] download one variant
kolm models prefetch [--tier=<t>] [--concurrency N] pull every variant in a tier
kolm models cache list [--json] what is on disk
kolm models cache clear [<id>] delete one model or all
kolm models cache rescan rebuild index.json from disk
```

## Tiers

Tiers are keyed off the GGUF download size, not the GPU class. Pick the one that
fits the disk and bandwidth you can spare.

| tier | typical models | rough size |
| --- | --- | --- |
| `edge` | SmolLM2-1.7B, Qwen 2.5 0.5B / 1.5B, Phi 3.5 mini | ~7 GB |
| `mobile` | Gemma 2 2B, Phi 3.5 mini, Llama 3.2 3B | ~6 GB |
| `laptop` | Qwen 2.5 7B, Llama 3.1 8B | ~10 GB |
| `workstation` | Qwen 2.5 14B / 32B, Llama 3.3 70B Q4 | ~50 GB |
| `datacenter` | Qwen 2.5 72B fp16, larger MoE variants | ~140 GB |

## Examples

```
kolm models list
kolm models info Qwen/Qwen2.5-7B-Instruct
kolm models recommend
kolm models pin Qwen/Qwen2.5-7B-Instruct
kolm models manifest --tier=edge
kolm models prefetch --tier=edge
kolm models pull microsoft/Phi-3.5-mini-instruct
kolm models pull Qwen/Qwen2.5-7B-Instruct --variant=q4_0
kolm models cache list
kolm models cache clear Qwen/Qwen2.5-0.5B-Instruct
kolm models cache rescan
```

## How the puller works

The puller streams over `node:https` with Range support, so an interrupted
download resumes from `<file>.part` instead of restarting. SHA-256 is verified
when the manifest carries the hash; otherwise byte-count is the integrity
check. Files land at `~/.kolm/models/<slug>/<filename>` and the JSON index at
`~/.kolm/models/index.json` tracks every entry.

If the dev machine crashes mid-prefetch and the index falls behind the on-disk
files, `kolm models cache rescan` walks the directory, matches each slug against
the manifest, and rewrites `index.json` to reflect truth.

## Related

- `/models` is the public catalog page; its pre-cached weights section reads
  `/v1/models/manifest` and `/v1/models/cache` live.
- `kolm compile --tier=<t>` compiles against the matching base.
- `kolm doctor --detect-hw` recommends a tier based on local hardware.
