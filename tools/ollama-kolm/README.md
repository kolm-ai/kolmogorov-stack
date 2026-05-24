# ollama .kolm plugin scaffold

STATUS: DRAFT, 2026-05-24

This directory holds the scaffolding for an `ollama` plugin that resolves
`kolm://artifact-hash` URIs against the local kolm artifact registry and
serves the matching weights via the existing ollama runtime. It is a
draft; nothing here is wired into either ollama or the kolm CLI yet.

## Goal

Make this work, end to end:

```
ollama pull kolm://sha256-abc123...
ollama run kolm://sha256-abc123... "Hello"
```

The first command locates the `.kolm` archive in `~/.kolm/artifacts/`,
verifies its signature using kolm CLI's existing primitives, unpacks
`weights.bin` plus the manifest, translates the manifest into an ollama
`Modelfile`, and registers the result under ollama's local model store.
The second command is plain ollama from that point on.

The plugin never re-downloads from kolm.ai if the artifact is already in
the local registry. If the artifact is missing locally, the plugin
delegates to `kolm pull` so the download path stays one piece of code.

## Manifest -> ollama Modelfile translation rules

`.kolm` manifest fields map onto Modelfile directives as follows:

| .kolm manifest field            | ollama Modelfile directive   | Notes                                                                            |
| ------------------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| `weights.bin` (extracted)       | `FROM ./weights.bin`         | absolute path under the plugin's staging dir                                     |
| `manifest.base_model`           | `# kolm-base: <name>`        | comment only; ollama doesn't enforce base lineage                                |
| `manifest.template`             | `TEMPLATE """..."""`         | quoted as-is; the kolm template format is a strict subset of Modelfile templates |
| `manifest.system_prompt`        | `SYSTEM """..."""`           | absent -> directive omitted                                                      |
| `manifest.stop_tokens[]`        | `PARAMETER stop "<token>"`   | one directive per token                                                          |
| `manifest.generation.temp`      | `PARAMETER temperature <f>`  | absent -> ollama default                                                         |
| `manifest.generation.top_p`     | `PARAMETER top_p <f>`        | absent -> ollama default                                                         |
| `manifest.generation.num_ctx`   | `PARAMETER num_ctx <int>`    | absent -> 2048                                                                   |
| `manifest.license`              | `# kolm-license: <SPDX>`     | comment; kolm holds the authoritative license file inside the archive           |

Anything else in the manifest (attestation block, K-Score history,
provenance receipts, routing hints) is preserved in
`~/.kolm/artifacts/<hash>/manifest.json` for the kolm CLI to inspect but
is NOT projected into the Modelfile. ollama has no concept slot for
those fields and the plugin refuses to fabricate one.

## Auth

For public artifacts: no API key required. The plugin reads the
artifact from the local registry, which kolm pull already filled.

For private artifacts: the plugin honours `KOLM_API_KEY` from the
environment. If set, the wrapped `kolm pull` call uses it. If absent,
the plugin returns a clear `auth_required` error rather than failing
deep inside ollama's HTTP transport. The plugin never persists the API
key inside the ollama model store -- the key stays in the operator's
environment and is re-read on every pull.

## Limitations

These are intentional, not bugs:

- `manifest.attestation_block` is dropped during translation. ollama
  has no hook for TEE attestation enforcement, and silently dropping
  it would be dishonest. The plugin emits a `# kolm-attestation:
  manifest-verify-only` comment in the Modelfile so the operator can
  see that runtime attestation has been downgraded. If you need real
  attestation enforcement, run the artifact under the kolm runtime
  instead.

- K-Score gates do not run at ollama load time. The kolm CLI runs
  them once at pull time and refuses to install an artifact that
  fails its declared gates; ollama then sees a known-good artifact.
  Re-checking inside ollama would duplicate work without adding
  value, so the plugin doesn't.

- Multi-modal artifacts (image, audio, video) are not supported in
  this draft. ollama's image input path is single-modality and
  doesn't fit kolm's multi-modality manifest shape. Tracking under
  W824.

## Honest status

- Plugin not yet implemented.
- ollama's plugin ABI is still evolving; the manifest translation table
  above is locked but the registration mechanism (Modelfile-on-disk vs.
  programmatic API) will follow whatever upstream lands first.
- kolm CLI exposes `kolm pull --target ollama` as the equivalent
  one-shot for the manual path today.
