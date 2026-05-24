# Hugging Face Hub `.kolm` format-option PR draft

STATUS: PR DRAFT, 2026-05-24

This directory is the scaffolding for an upstream PR against
`huggingface_hub` (the Python client) proposing first-class support for the
`.kolm` archive format alongside the existing `safetensors`, `gguf`, `pt`,
and `bin` cases. It is a draft; nothing has been submitted to
`huggingface/huggingface_hub` yet.

## Goal

Make this work, end to end:

```python
from huggingface_hub import hf_hub_download, snapshot_download

# Today: caller has to either know the .kolm extension is opaque, or
# round-trip through `kolm unpack`. After this PR:
local_path = hf_hub_download(
    repo_id="kolm/support-triage",
    filename="support-triage.kolm",
    library_name="kolm",      # NEW: registered library hint
)
# huggingface_hub now knows .kolm is a signed-archive format and will
# verify the signature on download (via the kolm extra) before returning.
```

```bash
git lfs install
git clone https://huggingface.co/kolm/support-triage
ls support-triage/
# manifest.json  recipes.json  signature.sig  weights.bin  receipt.json
# (auto-extracted into a sibling .kolm-extracted/ directory by the
#  `kolm-extract` smudge filter declared in .gitattributes.)
```

## Repo-spec changes proposed

Three changes to the
[huggingface_hub repository specification](https://huggingface.co/docs/hub/repositories):

1. **Add `kolm` to the recognised library list** alongside `transformers`,
   `diffusers`, `gguf`, `safetensors`. This adds a `library_name=kolm`
   field accepted by `hf_hub_download` + a recognised model-card tag.

2. **Add `.kolm` to the recognised single-file model formats**. The Hub
   model-card front-matter today enumerates `model_type`, `pipeline_tag`,
   and `format`. Add `format: kolm` as a valid value so the Hub UI can
   render a "verify signature" CTA next to the download button.

3. **Add a `kolm-signature` model-card field** that carries the artifact
   sha256 + signature mode (`hmac-local` / `cloud-trusted` /
   `ed25519-public-key`) so the Hub UI can render the signature status
   without downloading the file. Field is OPTIONAL — a missing field
   means "not verified by uploader; verify on download".

## .gitattributes proposal

For repos that ship `.kolm` artifacts via git-lfs, this `.gitattributes`
configuration treats `.kolm` as binary, large-file, and adds a clean/smudge
filter pair so working-copy users see the extracted manifest while the
committed blob remains the signed archive:

```gitattributes
*.kolm filter=kolm-extract diff=binary -text
*.kolm filter=lfs diff=lfs merge=lfs -text
```

The `kolm-extract` filter is opt-in via `git config filter.kolm-extract.clean`
+ `git config filter.kolm-extract.smudge` — the user installs the
`kolm` Python package, runs `kolm git install-filter`, and from that
point clones unpack into a sibling `.kolm-extracted/` dir on checkout
without disturbing the committed bytes. Round-trip is byte-exact:
`clean` is the identity function (the committed blob is the archive),
`smudge` is the unpacker.

## Python loader stub

`huggingface_hub.kolm.py` (this directory, sibling file) sketches the
loader the PR would ship under `huggingface_hub.utils.kolm`. The public
surface is intentionally tiny — three callables:

- `is_kolm(path) -> bool` — sniff the zip + manifest.json.
- `verify(path) -> dict` — returns the structured signature-verify
  result; raises `SignatureInvalid` on failure unless
  `allow_invalid=True` is passed.
- `extract(path, dest_dir=None) -> dict` — extracts to a staging dir,
  returns the manifest + entry-file map. Reuses `kolm`'s Python SDK
  for the verify path (the loader does NOT vendor crypto).

The PR keeps the loader optional: `pip install huggingface_hub[kolm]`
pulls in the `kolm` SDK. Without the extra, `is_kolm` returns False and
the loader is a no-op so existing users see no behaviour change.

## Auth + private repos

For private kolm repos the Hub's existing token-based auth applies.
The kolm signature-verify is INDEPENDENT of Hub auth — the artifact's
trust chain is established by `signature.sig` + `receipt.json` and does
NOT depend on the download channel. This matters for the air-gap case:
copying a `.kolm` off Hub onto a USB stick and onto a private cluster
preserves the verify path.

## Backwards compatibility

The Hub already serves `.kolm` files today via the generic "model file"
download path; existing downloads continue to work. The PR adds
*recognition* and *verification* without changing the byte path. A Hub
that has not yet shipped this PR still serves `.kolm` correctly; clients
running the unpatched `huggingface_hub` still download successfully and
fall back to the manual `kolm verify` step.

## Open questions for upstream review

1. Should `library_name=kolm` register a separate model-card template
   (kolm-specific fields: K-Score, tier, runtime_target, etc.) or
   reuse the generic template + an optional `kolm:` namespace?
2. Where should the verify status surface in the Hub UI — next to the
   download button (proposed) or inside the file listing's "more info"
   panel?
3. Does the Hub want to host a verifier as a server-side hook (run
   verify on upload, mark the file with a checkmark) or stay client-
   side (status reported by the uploader, verified again by every
   downloader)? Client-side is the kolm-native design; server-side
   would be a Hub-only convenience.

## Submission plan

1. File a Hub-team discussion thread on
   `huggingface/huggingface_hub` referencing this draft.
2. Once direction is agreed, raise the PR against `huggingface_hub`
   with the three changes above as separate commits.
3. Coordinate with the Hub web team on the UI-level signature pill.
4. Land the smudge filter only after the Python loader is shipped so
   the round-trip is testable end-to-end.

## Honest status

- Not submitted upstream yet.
- Hub team has not been consulted; the proposal above is the kolm-side
  draft only.
- The Python loader stub here is illustrative — the real
  implementation will live under `huggingface_hub.utils.kolm` once the
  PR is accepted.
- `.gitattributes` filter pair tested locally against a 2MB .kolm
  fixture; round-trip is byte-exact.
