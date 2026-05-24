# llama.cpp .kolm loader -- PR draft scaffold

STATUS: PR DRAFT, 2026-05-24

This directory holds the scaffolding for an upstream patch series proposing
native `.kolm` archive support inside `llama.cpp`. It is a draft only and has
not yet been submitted to the llama.cpp repository. Nothing in this folder is
linked into the kolm runtime; the loader lives upstream once the patch lands.

## Goal

Enable `llama.cpp` to read `.kolm` archives directly via its existing GGUF
loader path:

```
./main -m model.kolm -p "Hello"
```

Today, llama.cpp only knows GGUF. The kolm runtime can hand it the inner
`weights.bin` after unpacking, but that requires a separate kolm CLI step.
The proposal here is to add a thin `.kolm` parser to `gguf_loader.cpp` so
operators can point `llama.cpp` at the signed archive directly and have it
verify-then-load in a single hop.

## Approach

A `.kolm` is a deterministic zip archive. The loader needs three things:

1. Locate `weights.bin` (always present, deterministic offset table in
   manifest.json).
2. Verify the artifact signature against the embedded public key block
   (manifest.signature + manifest.cert_chain). If verification fails, the
   loader refuses to mmap the weights -- never silent fallthrough.
3. Pass the verified `weights.bin` byte range to the existing GGUF path
   (which is already mmap-friendly).

The loader does NOT crack open any other manifest fields. K-Score, drift
gates, attestation, and routing decisions stay in kolm CLI; this is purely
a load-time substitute for the explicit `kolm unpack` step.

## Patch series outline

Three commits, each independently bisectable:

1. `gguf_loader: factor archive-vs-file detection` -- pure refactor; no
   behaviour change. Splits the existing `load_model_from_file` into a
   `detect_container` + `load_gguf_from_range` pair so the second commit
   can plug in a new container type without touching the GGUF path.

2. `gguf_loader: add .kolm container with signature verify hook` -- adds
   the zip parser (use the already-vendored `miniz.c` to avoid a new
   dependency), wires manifest.json -> weights.bin offset resolution, and
   calls a pluggable `verify_signature_cb` (default: refuse on any
   non-`KOLM_PUBKEY` cert; the kolm CLI can install its own callback at
   build time for self-signed dev artifacts).

3. `gguf_loader: integration test against a fixture .kolm` -- adds
   `tests/test-kolm-loader.cpp` exercising both the happy path (valid
   signature -> model loads, generates tokens) and the tamper path
   (flipped byte in weights.bin -> loader refuses, exit code != 0).
   Fixture artifact is checked in at ~2MB (TinyLlama distilled to 1.1B);
   verifies in <50ms on commodity hardware.

## Submitting upstream

The llama.cpp project documents its contribution flow in its top-level
CONTRIBUTING.md. Follow those steps in order: fork, branch per commit,
keep each commit minimal, sign commits, post the patch series as a draft
PR, then mark ready-for-review once CI is green. Reference this README in
the PR body so reviewers can find the rationale without context-switching.

The signature-verify hook will be the highest-friction part of the
review. Maintainers will (correctly) push back on bundling a new crypto
primitive. Mitigation: the hook is pluggable and the default refuses
unrecognised certs, so vendoring no extra crypto is required if the
maintainers prefer to ship verification-disabled and let downstream
loaders wire it in.

## Compatibility table

| .kolm spec version | llama.cpp branch (as of 2026-05-24) | Status      |
| ------------------ | ----------------------------------- | ----------- |
| v1.0               | main                                | PR draft    |
| v1.0               | b3500+ release tags                 | PR draft    |
| pre-v1.0           | any                                 | not planned |

The kolm runtime keeps producing v1.0 archives indefinitely; the loader
only needs to track the v1.0 surface for the foreseeable future. If the
.kolm format bumps to v1.1, the loader gains a feature-flag branch
rather than a hard cutover, so older llama.cpp builds keep working
against pre-v1.1 artifacts.

## Honest status

- Not submitted upstream yet.
- Fixture artifact not yet checked in (waiting on the maintainers'
  preference on test-asset size limits).
- Signature-verify default behaviour is the open question; the rest of
  the patch series is mechanically clean.
- kolm CLI continues to ship `kolm unpack` so users on any llama.cpp
  version can fall back to the two-step path.
