# Runtime Adoption Packets

This packet is the local closeout for `ecosystem-runtime-adoption`. It prepares
integration packets for external runtimes and model hubs without claiming that
those projects have merged or published native support.

## Targets

### Hugging Face Hub

Use a model card README with YAML metadata, a `.kolm` artifact, manifest,
receipt, and model-index eval metadata. Hugging Face model-card docs describe
README-backed model cards, intended uses, training details, datasets, eval
results, and metadata fields:
https://huggingface.co/docs/hub/en/model-cards

### Ollama

Ship a Modelfile, GGUF file when available, `.kolm` sidecar, and verifier
command. Ollama documents Modelfile instructions including `FROM`, `PARAMETER`,
`TEMPLATE`, `SYSTEM`, `ADAPTER`, `LICENSE`, `MESSAGE`, and `REQUIRES`:
https://docs.ollama.com/modelfile

### llama.cpp

Ship GGUF, `.kolm` sidecar metadata, receipt JSON, and a launcher command that
keeps `kolm verify` adjacent to `llama-cli`. The llama.cpp README documents
GGUF use, local execution, Hugging Face download support, and a broad backend
matrix:
https://github.com/ggml-org/llama.cpp

### ONNX/GGUF Tooling

Ship conversion recipes, metadata maps, hash manifests, and conformance
fixtures so external tools can validate what metadata survives conversion.

### Hardware Partner

Ship device profiles, runtime targets, latency fixtures, energy fixtures, and
attestation fields. Production traces should align with OpenTelemetry GenAI
semantic conventions:
https://opentelemetry.io/docs/specs/semconv/gen-ai/

## External Completion Rule

The packet is locally ready when all templates and evidence files exist. The
product requirement remains external-gated until
`reports/runtime-adoption-manifest.json` records public merged PRs, published
plugins, or signed partner artifacts.

```bash
node scripts/runtime-adoption-packets.mjs --template
node scripts/runtime-adoption-packets.mjs --validate reports/runtime-adoption-manifest.json
```

The manifest must cover Hugging Face Hub, Ollama, llama.cpp, ONNX/GGUF tooling,
and hardware partner targets. Each row needs an external HTTPS URL, merged or
published status, integration reference, evidence hash, conformance-report hash,
supported artifact subset, and all target-specific implemented fields.
