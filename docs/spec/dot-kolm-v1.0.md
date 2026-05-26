# .kolm format specification, v1.0

Status: STABLE, 2026-05-26
Spec ID: `kolm-format-1.0`
Canonical URL: `https://kolm.ai/docs/spec/dot-kolm-v1.0`
Companion JSON Schema: `https://kolm.ai/docs/spec/dot-kolm-v1.0.json`

> This document is the canonical specification for the `.kolm` artifact bundle
> format, version 1.0. It is a stable, versioned, RFC-style description of
> the byte-on-disk layout, the manifest schema, and the verification chain
> any conforming reader must implement. The companion machine-readable JSON
> Schema lives at `docs/spec/dot-kolm-v1.0.json`.

## 0. Why a separate format

A `.kolm` is not a model. It is the bundle that lets a third party stand up,
inspect, and verify a model someone else compiled, without trusting the
publisher. Six things have to ride together for that promise to hold:

1. The model weights (or a pointer to them).
2. The recipes that produced the model.
3. The evaluation set the model was graded against.
4. The signed receipt that anchors the whole bundle to a key.
5. The provenance / evidence DAG that names every upstream source.
6. The runtime metadata (passports) that says which runtimes have actually
   loaded and benchmarked the bundle.

A `.kolm` v1.0 is a single ZIP container holding exactly these things, with
deterministic byte layout, sorted entries, and a sha256-anchored manifest.

## 1. File container

A v1.0 `.kolm` artifact is a ZIP archive (PKZIP, RFC 1951 deflate) with the
file extension `.kolm`. Implementations MAY also accept the bundle as a
flat directory tree containing the same entries; the validator script
`scripts/dotkolm-validate.cjs` accepts either layout.

Compression: deflate. No password, no encryption layer, no nested archives.

Maximum size: there is no spec-mandated maximum, but readers SHOULD reject
artifacts larger than 100 GB without explicit operator opt-in (this protects
against zip-bomb style payloads).

ZIP entry ordering: entries SHOULD be sorted alphabetically by filename so
that two byte-identical builds produce byte-identical archives. Readers
MUST NOT depend on entry order — they MUST locate entries by name.

## 2. Required entries

Every v1.0 `.kolm` MUST contain these top-level entries:

| Entry | Purpose |
| ------------------ | ------- |
| `passport.json` | Machine-readable provenance + manifest. Schema in section 3. |
| `README.md` | Human-readable summary. Free-form text. |

The remaining entries are conditional. A reader MUST be able to validate
the artifact identity (`passport.json`) from these two alone.

## 3. passport.json schema

`passport.json` is a single UTF-8 JSON object. It is the authoritative
machine-readable manifest. Field-by-field:

### 3.1 Top-level identity (required)

| Field | Type | Constraint |
| ---------------------- | ------ | ---------- |
| `spec` | string | MUST be `"kolm-format-1.0"`. |
| `format_version` | string | MUST be `"1.0"`. |
| `artifact_id` | string | URL-safe slug, 1-128 chars matching `[A-Za-z0-9._-]+`. |
| `artifact_hash` | string | Hex sha256 (64 chars), `[0-9a-f]{64}`. |
| `cid` | string | Same shape as `artifact_hash`; deterministic content id over `hashes`. |
| `created_at` | string | ISO-8601 UTC timestamp. |
| `task` | string | Free-form task slug, 1-200 chars. |
| `artifact_class` | string | One of `rule \| synthesized_rule \| compiled_rule \| distilled_model`. |
| `runtime_target` | string | One of `js \| gguf \| onnx \| wasm \| native`. |
| `base_model` | string | Free-form base-model identifier (e.g. `Qwen/Qwen2.5-3B-Instruct`). |
| `license` | string | SPDX-style identifier (e.g. `Apache-2.0`). |

### 3.2 Provenance (required)

| Field | Type | Constraint |
| ---------------------- | ------ | ---------- |
| `seed_provenance` | object | See 3.2.1. |
| `hashes` | object | See 3.2.2. Per-file sha256 map. |

#### 3.2.1 seed_provenance

A nested object with these required sub-fields:

| Sub-field | Type | Meaning |
| ---------------------- | ------ | ------- |
| `eval_source` | string | One of `human_curated \| self_generated \| holdout_external \| holdout_tenant_shadow`. |
| `comparator` | string | One of `exact \| judge \| structured \| script`. |
| `production_ready` | boolean | Whether the build passed every gate. |
| `holdout_ratio` | number | Range [0.0, 1.0]. |

#### 3.2.2 hashes

Flat object mapping each bundled file's basename to a hex sha256.

Required keys (always present, `EMPTY_SHA` when payload absent):

- `passport_json` — sha256 of `passport.json` itself, computed with the
  `passport_json` slot zeroed during build.
- `weights` — sha256 of the bundled weights blob (or `EMPTY_SHA` when no
  weights are bundled). The actual filename of the weights blob is
  declared in `weights_filename` at the top level.

Optional keys (present only when the corresponding payload is bundled):
`tokenizer`, `eval_set`, `receipts`, `evidence_dag`, `compile_args`,
`runtime_passport`.

The constant `EMPTY_SHA` is the sha256 of zero bytes:
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

### 3.3 Signature (required)

| Field | Type | Meaning |
| ---------------------- | ------ | ------- |
| `signature` | object | Top-level signature block. See 3.3.1. |

#### 3.3.1 signature block

```
{
  "algorithm": "ed25519",
  "public_key": "<base64-pad-stripped Ed25519 public key>",
  "signature":  "<base64-pad-stripped Ed25519 signature>",
  "key_fingerprint": "<hex sha256 of public_key>",
  "signed_at": "<ISO-8601 UTC>",
  "payload_canonical_sha256": "<hex sha256 over canonical body>"
}
```

The signature is computed over the canonical-JSON encoding of
`passport.json` with the `signature` key removed. Canonical JSON means:

1. UTF-8 throughout.
2. Object keys sorted lexicographically at every level.
3. No insignificant whitespace.
4. No `NaN`, `Infinity`, `-Infinity`.

### 3.4 Conditional fields

These fields MAY be present. A v1.0 reader MUST tolerate unknown optional
fields (preserve on round-trip; do not fail validation). Adding a new
optional field is a backwards-compatible change (see section 7).

| Field | Type | When present |
| ---------------------- | ------ | ------------ |
| `weights_filename` | string | Bundled weights present. Filename inside the ZIP. |
| `tokenizer_filename` | string | Tokenizer bundle present. |
| `runtime_passports` | array | Per-(runtime, target) capability fingerprint. Schema in `src/runtime-passport.js`. |
| `eval_score` | number | Range [0, 1], 4 decimals. |
| `k_score` | object | Calibrated K-score: `{point, ci95: [low, high], calibration_pack_id}`. |
| `judge_id` | string | Judge identifier used to compute `eval_score`. |
| `tier` | string | One of `recipe \| adapter \| specialist \| bundle`. |
| `parent_cid` | string | sha256 of predecessor artifact (lineage chain). |
| `policy` | object | `{require_ed25519: bool, require_rekor: bool}`. |
| `compile_args` | object | Reproducibility-grade compile arguments. |
| `evidence_dag` | object | Embedded copy of the evidence DAG (matches `evidence_dag.json` bytes). |

## 4. Standard bundle layout

When the corresponding payload is bundled, these entries SHOULD be present
at the canonical paths below. The validator script accepts variants only
when their filename is declared explicitly in `passport.json`.

| Path | Contains |
| ---------------------- | -------- |
| `passport.json` | This manifest. REQUIRED. |
| `README.md` | Human-readable summary. REQUIRED. |
| `weights/<file>` | Model weights (e.g. `weights/model.gguf`, `weights/lora.safetensors`). |
| `tokenizer/<file>` | Tokenizer files (e.g. `tokenizer/tokenizer.json`). |
| `eval/eval_set.jsonl` | Eval cases the build was graded against. |
| `receipts/receipt.json` | Build receipt (Ed25519 + HMAC chain). |
| `receipts/training_receipts.jsonl` | Per-step training receipts when applicable. |
| `evidence_dag.json` | Provenance DAG (capture lineage, teacher rollouts, gates). |
| `compile_args.json` | Reproducibility arguments. |

The flat-directory layout substitutes the bundle root for the ZIP root;
otherwise paths are identical.

## 5. Verification chain

A conforming reader MUST execute these steps in order. A failure at any
step is a hard verification failure — the reader MUST refuse to load the
artifact further.

1. **Container parse**. Open the ZIP, enumerate entries. Reject if
   `passport.json` is missing.
2. **Schema validate**. Parse `passport.json` as JSON. Validate against the
   JSON Schema in section 9 (file: `dot-kolm-v1.0.json`).
3. **Version gate**. Confirm `format_version` is accepted by the reader.
   v1.0 readers MUST accept `"1.0"` and SHOULD warn (not fail) on
   `"1.x"` for forward-compatible reads.
4. **Hash recompute**. For each entry declared in `hashes`, sha256 the
   bytes inside the container and compare. Mismatch = fail.
5. **Signature verify**. Re-canonicalize `passport.json` with the
   `signature` key removed, sha256 it, and verify the Ed25519 signature
   against the declared `public_key`. Mismatch = fail.
6. **Optional registry cross-check**. If the reader has network access
   and the operator has not disabled it, fetch
   `https://kolm.ai/v1/verify/{cid}` and compare the returned manifest
   hash against the local recompute. A 200 + matching hash means the kolm
   registry has anchored this artifact; a 404 means the artifact is
   unpublished but otherwise valid; a 200 + mismatch is a hard failure.

After step 5 the artifact identity is established. After step 6 the
artifact is registry-anchored. A reader MAY surface the difference
between "valid + anchored" and "valid + unpublished" but MUST NOT treat
unpublished as a verification failure.

## 6. Compression and signing rationale

ZIP + deflate was chosen over tar+gz, tar+zstd, and OCI layouts for these
reasons:

- ZIP supports random access without streaming the whole archive. A
  reader that only needs to validate `passport.json` reads ~1 KB
  regardless of bundle size.
- Off-the-shelf ZIP libraries exist in every language. The Node, Python,
  Go, and Rust standard libraries all parse ZIP without an external
  dependency.
- Sorted-entry determinism: a reproducible build produces a byte-identical
  ZIP when entries are sorted (the central directory ordering matches).

Ed25519 was chosen over RSA + ECDSA for these reasons:

- Smaller signatures (64 bytes vs 256+).
- Fast verify on hardware without dedicated crypto units (edge devices).
- No nonce — re-signing the same payload produces a stable signature
  byte-for-byte. This matters for reproducibility tests.

Future versions MAY add layered signatures (Sigstore, Rekor) per the
`signature_sigstore` block already shipping on v1.0 builders. v1.0
readers MUST tolerate the field when present.

## 7. Versioning rules

Semantic versioning applies:

- **Major bump (`1.0` -> `2.0`)**: breaking change to the container
  layout, the required-field set, the signature scheme, or the
  verification chain. A v1.0 reader MAY refuse to load `2.x` artifacts.
- **Minor bump (`1.0` -> `1.1`)**: backwards-compatible addition. New
  optional fields, new optional bundle entries, new optional signature
  layers. A v1.0 reader MUST load `1.x` artifacts (ignoring unknown
  optional fields), and MUST round-trip unknown fields without modification.
- **Patch bump (`1.0.0` -> `1.0.1`)**: editorial corrections to the spec.
  No on-the-wire change. Readers do not need to be updated.

`format_version` always declares major+minor (e.g. `"1.0"`, `"1.1"`,
`"2.0"`). Patch versions are tracked in the spec document, not in the
artifact.

## 8. Reference implementation

The reference encoder lives at:

- **Node**: `src/forge-export.js` (in this repo) — assembles passport +
  bundle entries, applies the Ed25519 signature, emits the ZIP.
- **Python**: `apps/export/run.py` — mirror of the Node path for
  Python-driven compile pipelines.

The reference validator lives at:

- **Node**: `scripts/dotkolm-validate.cjs` — accepts a `.kolm` file or
  flat directory, walks the verification chain (section 5), prints
  `pass`/`fail` with structured errors. Exit code 0 on success, non-zero
  on any failure.

Schema validators in other languages SHOULD use the JSON Schema at
`docs/spec/dot-kolm-v1.0.json` as the contract source. The schema is
generated from the table in section 3 and tracks it commit-for-commit.

## 9. JSON Schema

The companion file `docs/spec/dot-kolm-v1.0.json` is the JSON Schema for
`passport.json`. It uses draft-2020-12, `$id` =
`https://kolm.ai/docs/spec/dot-kolm-v1.0.json`. Implementations MAY
embed it as a static dependency.

## 10. Test vectors

Three test vectors live at `tests/fixtures/dotkolm/`:

| Fixture | Purpose |
| ---------------------- | ------- |
| `valid-minimal.kolm` | Smallest valid `.kolm`: dummy weights + minimal passport. ~2 KB. |
| `valid-full.kolm` | Full-featured: passport + weights + tokenizer + eval + receipts + evidence DAG. ~10 KB. |
| `invalid-missing-passport.kolm` | Fails validation (passport.json absent). |

The validator's behaviour against each fixture is pinned by
`tests/wave889-9-10-spec-marketplace.test.js`. These are synthetic test
vectors, not real models — file sizes are intentionally tiny so the test
suite runs offline.

## 11. Ecosystem readers

Reader-side adoption is tracked at `docs/spec/ecosystem-prs.md`. A reader
that intends to claim v1.0 compliance MUST pass the test-vector suite in
section 10 — i.e., it must accept `valid-minimal.kolm` and
`valid-full.kolm`, and reject `invalid-missing-passport.kolm` with a
clear error message naming the missing required entry.

## 12. Change process

Material changes to this spec follow `docs/spec/CHANGE_PROCESS.md`:

1. Open an RFC pull request on `kolmogorov-stack` describing the change.
2. Bump `format_version` in the spec document AND the JSON Schema.
3. Add a fixture covering the new behaviour.
4. Update the validator to recognise the new field.
5. Land the change in a single commit so spec, schema, validator, and
   fixtures move together.

## 13. References

- Canonical encoder (Node): `src/forge-export.js`, `src/artifact.js`.
- Canonical encoder (Python): `apps/export/run.py`.
- Runtime passport schema: `src/runtime-passport.js`.
- Build receipt schema: `src/passport.js`, `src/receipt.js`.
- Evidence DAG schema: `src/evidence-dag.js`.
- Validator: `scripts/dotkolm-validate.cjs`.
- JSON Schema: `docs/spec/dot-kolm-v1.0.json`.
- Predecessor draft: `docs/spec/kolm-format-v1.0.md`.
- Ecosystem readers tracker: `docs/spec/ecosystem-prs.md`.
- Change process: `docs/spec/CHANGE_PROCESS.md`.
