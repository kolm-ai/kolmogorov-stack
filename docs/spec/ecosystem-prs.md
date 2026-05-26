# .kolm v1.0 ecosystem reader adoption

Status: tracking, 2026-05-26.

This document tracks the upstream pull requests we intend to open against
ecosystem runtimes and tooling to add `.kolm` v1.0 recognition. Each
target lists: the upstream repository, the proposed PR title and
description, the target branch we would push from, the exact diff (kept
small on purpose — usually a one-line addition to a MIME-type map or
recognised-format list), and a STATUS field.

We do not open these PRs without explicit operator authorisation. The
draft text and diffs are committed here so the work is visible and
reproducible the moment the green light arrives.

## Status legend

| Status | Meaning |
| ------------ | ------- |
| `drafted` | PR text and diff written; not yet opened upstream. |
| `prepared`  | Local fork branch staged; ready to push when authorised. |
| `submitted` | PR is open upstream; awaiting maintainer review. |
| `revisions` | Maintainer asked for changes; we are iterating. |
| `merged` | PR landed in the upstream main branch. |
| `closed` | PR closed without merge; reason noted in the row. |

---

## Target 1: Ollama — recognise `.kolm` as an import format

- **Upstream**: `ollama/ollama`
- **Branch we'd push from**: `kolm-ai/kolm-format-recognition`
- **STATUS**: `drafted`

**PR title**: Recognise `.kolm` artifact bundles in `ollama create`

**PR description (proposed)**:

> The `.kolm` format is a signed, verifiable model + recipe + eval bundle
> defined at https://kolm.ai/docs/spec/dot-kolm-v1.0. It packages weights
> with a manifest (`passport.json`), provenance DAG, and Ed25519 signature
> so the consumer can verify the artifact's identity offline before load.
>
> This PR teaches `ollama create` to accept a `.kolm` file as the source.
> When pointed at a `.kolm`, `ollama` reads `passport.json`, locates the
> weights blob declared in `weights_filename` (typically `weights/model.gguf`),
> verifies the sha256 against the manifest, and proceeds with the existing
> GGUF import path. Non-GGUF runtime_targets are rejected with a clear
> `not_supported: runtime_target=<x>` message.
>
> A future PR can wire the optional Ed25519 signature verify; this one
> is the minimum entry point.

**Proposed diff (conceptual)**:

```
diff --git a/cmd/create.go b/cmd/create.go
+ // Accept .kolm bundles: read passport.json, expect runtime_target=gguf,
+ // extract the weights blob declared in weights_filename, then fall
+ // through to the existing GGUF import path.
+ if strings.HasSuffix(src, ".kolm") {
+     src, err = importKolmBundle(src)
+     if err != nil { return err }
+ }
```

---

## Target 2: llama.cpp — `.kolm` loader

- **Upstream**: `ggerganov/llama.cpp`
- **Branch we'd push from**: `kolm-ai/kolm-format-loader`
- **STATUS**: `drafted`

**PR title**: Add `.kolm` bundle loader (extracts inner GGUF, validates manifest)

**PR description (proposed)**:

> `llama.cpp`'s `llama-cli` and `llama-server` accept GGUF directly. This
> PR adds a thin wrapper that recognises the `.kolm` v1.0 bundle format
> (https://kolm.ai/docs/spec/dot-kolm-v1.0), reads the passport.json
> manifest, locates the inner GGUF declared at `weights/<file>`, sha256-
> verifies it against the manifest hashes block, and hands the GGUF bytes
> to the existing loader. Bundles with `runtime_target != gguf` are
> rejected.
>
> The wrapper depends only on miniz (already vendored for the `.gguf.zip`
> path) and `sha256.h` (already in `ggml/`). No new dependencies.

**Proposed diff (conceptual)**: ~120 LoC in `common/kolm-bundle.cpp` plus
a 6-line entry in `common/arg.cpp` to dispatch on the `.kolm` extension.

---

## Target 3: vLLM — `.kolm` model spec

- **Upstream**: `vllm-project/vllm`
- **Branch we'd push from**: `kolm-ai/kolm-format-model-spec`
- **STATUS**: `drafted`

**PR title**: Accept `.kolm` artifact bundles as `--model` argument

**PR description (proposed)**:

> vLLM's `--model` flag accepts a HuggingFace repo id or a local path to a
> HF-style snapshot directory. The `.kolm` format
> (https://kolm.ai/docs/spec/dot-kolm-v1.0) is a signed bundle that wraps
> the same artifacts plus a manifest, evidence DAG, and Ed25519 signature.
>
> This PR adds a loader at `vllm/engine/arg_utils.py` that detects a
> `.kolm` path, unpacks it to a temporary directory, validates
> `passport.json` (sha256 over each declared file), and proceeds with the
> existing HF snapshot loader pointed at the unpacked directory. The temp
> directory is reused across worker init so the unpack happens once.
>
> Bundles must declare `runtime_target = native` (covering the HF
> safetensors layout vLLM consumes); other targets raise
> `UnsupportedRuntimeTarget`.

**Proposed diff (conceptual)**: ~90 LoC in `vllm/utils/kolm_bundle.py`,
plus a `try_unpack_kolm()` call at the head of `engine_args.create_engine_config()`.

---

## Target 4: LM Studio — `.kolm` import in the discover panel

- **Upstream**: `lmstudio-ai/lmstudio.js` (the public JS SDK; LM Studio
  itself is closed-source, but the SDK ships the import contract).
- **Branch we'd push from**: `kolm-ai/kolm-format-sdk-import`
- **STATUS**: `drafted`

**PR title**: Add `kolm` source kind to `lms.import()`

**PR description (proposed)**:

> Extend `lms.import()` (the model-loading entry point in the LM Studio
> JS SDK) to recognise a `.kolm` bundle path. The implementation reads
> `passport.json`, locates the GGUF declared at `weights/<file>`,
> sha256-verifies it, and forwards the unpacked path to the existing
> GGUF loader.

**Proposed diff (conceptual)**: ~60 LoC in `src/import/kolm.ts`, one
new case in the import switch in `src/import/index.ts`, schema in
`src/schemas/kolm-passport.ts` (auto-generated from
`https://kolm.ai/docs/spec/dot-kolm-v1.0.json`).

---

## Target 5: HuggingFace Hub — `.kolm` MIME type + repo file recognition

- **Upstream**: `huggingface/huggingface_hub`
- **Branch we'd push from**: `kolm-ai/kolm-format-mime`
- **STATUS**: `drafted`

**PR title**: Add `application/vnd.kolm.artifact+zip` MIME and `.kolm` extension

**PR description (proposed)**:

> Register the `.kolm` extension as a first-class artifact type on the
> Hub so a repo containing `model.kolm` is recognised in the UI and the
> file viewer can render the manifest preview.
>
> This PR adds:
> 1. A `KOLM_ARTIFACT` constant in `huggingface_hub/utils/_typing.py`.
> 2. The `application/vnd.kolm.artifact+zip` MIME entry in
>    `huggingface_hub/utils/_http.py` content-type map.
> 3. A small `read_kolm_passport(repo_id, filename)` helper that fetches
>    the manifest entry from a `.kolm` in a repo without downloading
>    the whole archive (uses HTTP Range requests + the ZIP central
>    directory lookup pattern).

**Proposed diff (conceptual)**: ~40 LoC across the three files above,
plus a test fixture that mirrors `tests/fixtures/dotkolm/valid-minimal.kolm`.

---

## Target 6: Anthropic / OpenAI SDKs — `.kolm` as a passport-aware uploadable

- **Upstream**: `anthropics/anthropic-sdk-python`, `openai/openai-python`
- **Branch we'd push from**: `kolm-ai/kolm-format-passport-attach`
- **STATUS**: `drafted`

**PR title**: Surface `.kolm` passport as a structured upload attachment

**PR description (proposed)**:

> When a `.kolm` artifact is uploaded as a file attachment to a chat
> completion (e.g., a user shares a compiled model with an agent for
> audit), the SDK currently treats it as an opaque ZIP. This PR adds an
> opt-in helper `attach_kolm(path)` that reads `passport.json` from the
> bundle and exposes it as structured metadata alongside the file upload
> so the model sees `{artifact_id, cid, eval_score, judge_id, ...}`
> without the agent needing to unpack the ZIP server-side.

**Proposed diff (conceptual)**: ~80 LoC in a new `helpers/kolm.py` module
per SDK, no changes to the underlying request payload (metadata rides
in the existing `metadata: dict` slot).

---

## Verification plan

Before opening any of the PRs above, we verify the diff works against
the three test vectors at `tests/fixtures/dotkolm/`:

1. `valid-minimal.kolm` — loader must succeed; the reader picks up the
   weights blob, sha256s it, returns OK.
2. `valid-full.kolm` — loader must succeed; the optional tokenizer +
   eval + receipts + evidence_dag entries are recognised but not required.
3. `invalid-missing-passport.kolm` — loader must refuse with a clear
   error naming the missing `passport.json` entry.

Each target's PR text includes a "Verified against kolm test vectors"
checklist row so the upstream reviewer can re-run the same three checks
locally.

## Bookkeeping

- Tracker file: this document.
- Test vectors: `tests/fixtures/dotkolm/`.
- Reference validator: `scripts/dotkolm-validate.cjs`.
- Canonical spec: `docs/spec/dot-kolm-v1.0.md`.
- JSON Schema: `docs/spec/dot-kolm-v1.0.json`.
