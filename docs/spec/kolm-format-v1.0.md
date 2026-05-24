# kolm format specification, v1.0

STATUS: DRAFT, 2026-05-24

This document specifies version 1.0 of the .kolm artifact format. A .kolm
artifact is the durable, signed unit that the kolm compiler (`src/artifact.js`)
produces and that downstream runtimes consume. The format is designed to be
auditable years after the fact: every byte that influences trust is named,
hashed, and bound to the artifact identity.

Canonical URL: this spec will be hosted at `https://kolmspec.org/v1.0/` once
the domain lands. Until then the kolm repository is the source of truth.
TODO(W817-2): register kolmspec.org and redirect `kolmspec.org/v1.0` to
`https://kolm.ai/docs/spec/kolm-format-v1.0.html`. No DNS purchase is part of
this wave; the placeholder lives here so external readers can cite a stable URL.

## 1. Overview

A .kolm artifact is a ZIP container with a fixed set of top-level entries.
Six entries are required on every artifact; the rest are conditional on the
artifact class (rule, synthesized_rule, compiled_rule, distilled_model) and on
optional capability blocks (workflow IR, attestation, model weights, extra
files).

Readers MUST be able to verify the artifact identity and the signing chain
from the ZIP alone, with no network access. The artifact identity is
`artifact_hash`, a sha256 computed over a canonical JSON of named hash slots
(see section 5). `artifact_hash` is recorded in both `manifest.json` and
`receipt.json`.

The format is intentionally simple. There is no nested archive, no custom
compression, no proprietary index. A reader written in plain C, Python, or
Rust can implement the full spec in under 500 lines of code, with only a ZIP
library and a sha256 implementation as external dependencies.

## 2. File layout

A v1.0 .kolm artifact MUST contain these top-level entries (these are exactly
the six the canonical builder emits before any optional payload):

| Entry | Required | Purpose |
| ------------------ | -------- | ------- |
| `manifest.json`    | yes | Machine-readable manifest. Schema in section 3. |
| `recipes.json`     | yes | Canonical recipe registry. Hash anchored by `manifest.hashes.recipes_json`. |
| `evals.json`       | yes | Eval set the K-score was computed over. Hash anchored by `manifest.hashes.evals_json`. |
| `signature.sig`    | yes | Legacy HMAC-SHA256 signature over canonical `{spec, manifest_hash, job_id, artifact_hash, eval_set_hash, eval_score, judge_id}`. Kept for v0 verifiers. |
| `receipt.json`     | yes | Authoritative signed receipt. Schema in section 4. Carries Ed25519 + optional Sigstore signatures. |
| `credential.json`  | yes | Artifact-scoped provenance credential, signed with the same secret as the receipt chain. |

Conditional entries (present only when the corresponding capability is
declared in the manifest):

| Entry | Condition | Purpose |
| ----------------------- | ----------------------------------- | ------- |
| `model.gguf`            | non-null `model_pointer` payload | Pointer-style weight blob or weight-class artifact body. |
| `lora.bin`              | `manifest.hashes.lora_bin != EMPTY_SHA` | LoRA adapter weights. |
| `index.sqlite-vec`      | `manifest.hashes.index_bin != EMPTY_SHA` | RAG index blob. |
| `workflow_ir.json`      | manifest declares `workflow_ir_hash` | Executable workflow IR; verifier replays `hashIr()`. |
| `attestation_report.json` | manifest declares `confidential_compute` | Raw TEE attestation report (PCCS / SNP / Nitro / NRAS). |
| `recipe.bundle.mjs`     | manifest carries `entry.file` | Self-contained ESM recipe bundle (Node 18+ / Bun 1+ / Deno 1.40+). |
| `<weight_filename>`     | `manifest.hashes.model_weights` set | Bundled model weights (e.g. `model.gguf`, `model.onnx`, `target.wasm`, native binary). |
| Compiled-target sources | manifest declares `compiled_targets` | One C and one Rust source per compiled recipe (filenames listed in `compiled_targets`). |
| `tokenizer.json`, etc.  | manifest declares `hashes.extra_files` | Any auxiliary blob. Sorted by filename, hashed individually. |

The constant `EMPTY_SHA` is the sha256 of zero bytes
(`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`) and is
used as the honest-empty marker for absent payloads, so every hash slot is
present in the manifest even when the payload is not bundled.

Readers MUST reject artifacts missing any of the six required entries.
Readers MAY accept additional top-level entries for forward-compatibility
but MUST NOT use them when recomputing `artifact_hash`; only the slots
enumerated in section 5 contribute to the artifact identity.

## 3. manifest.json schema

The manifest is a single JSON object. v1.0 readers MUST parse the following
required fields:

| Field | Type | Meaning |
| --------------------- | ------ | ------- |
| `spec`                | string, `"kolm-1"` | Format spec marker. Future major bumps will rename to `"kolm-2"`, etc. |
| `format_version`      | string, semver | Declared format version. v1.0 artifacts MUST declare `"1.0"`. |
| `job_id`              | string | Build-job identity. UUID or other opaque token. |
| `task`                | string | Human-readable task slug. |
| `created_at`          | string, ISO-8601 | Build timestamp. |
| `runtime`             | string | Alias of `runtime_target` (W457 lock so the two cannot diverge). |
| `runtime_target`      | string, enum | One of `js | gguf | onnx | wasm | native`. |
| `artifact_class`      | string, enum | One of `rule | synthesized_rule | compiled_rule | distilled_model`. |
| `base_model`          | string | e.g. `"Qwen/Qwen2.5-3B-Instruct"`. |
| `tier`                | string, enum | One of `recipe | adapter | specialist | bundle`. |
| `judge_id`            | string | Identifier of the judge that produced `eval_score`. |
| `eval_score`          | number, [0,1], 4-decimal | Holdout pass rate. |
| `recipes`             | object | `{ n: int, registry_hash: sha256 }`. |
| `evals`               | object | `{ n: int, spec: string, hash: sha256 }`. |
| `seed_provenance`     | object | See section 3.1. |
| `hashes`              | object | Per-file sha256 map; see section 3.2. |
| `cid`                 | string, sha256 | Deterministic content-id over `hashes`. |
| `policy`              | object | `{ require_ed25519: bool, require_rekor: bool }`. |
| `binaries`            | array | `[{target, kind, filename, sha256, size, ...}]`. Honest empty array when no target. |
| `compiled_binary`     | bool or null | null = no target requested; true = a binary was produced; false = target requested but toolchain failed. |
| `production_ready`    | bool | ANDs `seed_provenance.production_ready` with `compiled_binary`. |
| `memory_requirement_mb` | int | Working-set hint. |
| `offline_capable`     | bool | True when the artifact runs without network egress. |
| `license`             | string | Normalized SPDX-style license id. |

Optional fields are added by feature waves. v1.0 readers MUST tolerate
unknown optional fields (preserve on round-trip; do not fail validation).
The conditional-slot pattern (W460) is the format-stability law: an optional
field whose canonical value is null / absent / empty MUST NOT appear in the
manifest at all, so byte-identical re-builds of pre-feature artifacts stay
hash-stable.

Notable optional fields:

| Field | Source wave | Meaning |
| -------------------------- | ----------- | ------- |
| `target_device`            | W156 | `{device_class, memory_requirement_mb, offline_capable, ...}` runtime hint. |
| `train_device`             | W156 | Device the build ran on. |
| `lora`                     | W144 | LoRA pointer block. |
| `recall`                   | W144 | `{namespace}` for RAG-aware artifacts. |
| `training`                 | W151 | `{distilled_pairs, accuracy, teacher_vendor, teacher_model, synthesized_by}`. |
| `capability`               | WV   | Capability declaration block with own hash. |
| `lineage`                  | WV   | Build-lineage block with own hash. |
| `export`                   | W146 | Multi-target export block (gguf / onnx / coreml / mlx / executorch / tensorrt). |
| `moe`                      | W147 | Mixture-of-experts expert manifest. |
| `pretokenize`              | W148 | Pre-tokenized cache block. |
| `external_holdout_provenance`     | W164 | External adversarial holdout block. |
| `tenant_shadow_corpus_provenance` | W165 | Per-tenant shadow corpus blocks. |
| `auditor_attestation_provenance`  | W166 | Third-party auditor signatures. |
| `supersession_provenance`  | W167 | Pointer to predecessor + reason. |
| `drift_report`             | W167 | Drift verdict block. |
| `confidential_compute`     | W460 | TEE attestation pointer (`{attestation_kind, attestation_report_hash}`). |
| `mixed_precision_profile`  | W719 | DAQ per-layer bit budget array. |
| `sparsity_profile`         | W721 | TSAC per-(layer, head) sparsity profile. |
| `kv_profile`               | W722 | ITKV per-token-class precision schedule. |
| `output_schema`            | W809 | Canonicalized structured-output schema. |
| `output_schema_spec_version` | W809 | Schema canonicalizer version. |
| `guardrails`               | W736 | Brand-safety hard-constraint rules `[{name, pattern, action}]`. |
| `parent_cid`               | W739 | sha256 of the parent artifact's `cid` (lineage chain). |
| `region`                   | W769 | Data-residency region tag (e.g. `EU_WEST`). |
| `entry`                    | W367 | `{file, sha256, runtime, class, export}` for rule-class executable bundle. |
| `k_score`                  | W144 | Calibrated `{point, ci95: [low, high], calibration_pack_id}` (patched in pass 2 after first zip). |
| `ship_gate_overridden`     | W144 | `true` only when build proceeded below the eval gate. |

### 3.1 seed_provenance

The seed-provenance block is present on every v1.0 manifest. The verifier
branches on its shape — when `eval_source = "self_generated"` the artifact
is downgraded to a sample-check tier regardless of `eval_score`.

Required sub-fields: `seeds_hash, split_seed, holdout_ratio, train_hash,
holdout_hash, train_count, holdout_count, eval_source, comparator,
production_ready`. Conditional sub-fields include
`leakage_report_hash, source_format_mix, seeds_path_basename, min_train,
min_holdout, input_overlap_count, output_overlap_count,
near_duplicate_count, grouped_overlap_count, synthesis_input_hash,
group_key, source_seed_count, approved_count, synthetic_count,
event_source_hashes, eval_provenance`. Each is documented in
`src/artifact.js` around the `seed_provenance_block` constant.

### 3.2 hashes

`manifest.hashes` is a flat object of sha256 strings, one per top-level
file the artifact bundles. Every slot is present on every manifest; absent
payloads use `EMPTY_SHA`. The canonical keys are:

| Key | Meaning |
| ------------------ | ------- |
| `model_pointer`    | sha256 of the model pointer (or `EMPTY_SHA` when no pointer is bundled). |
| `recipes_json`     | sha256 of `recipes.json`. |
| `lora_bin`         | sha256 of `lora.bin` or `EMPTY_SHA`. |
| `index_bin`        | sha256 of `index.sqlite-vec` or `EMPTY_SHA`. |
| `evals_json`       | sha256 of `evals.json`. |

Conditional keys (present only when the corresponding payload was bundled):
`workflow_ir`, `attestation_report`, `recipe_bundle_mjs`, `model_weights`,
`extra_files` (this last is itself a sorted object mapping filename to sha256).

## 4. receipt.json schema

The receipt is the authoritative cryptographic witness. Required fields:

| Field | Type | Meaning |
| ------------------ | ------ | ------- |
| `kolm_version`     | string, `"0.1"` | Receipt schema version (separate from `format_version`). |
| `receipt_id`       | string, UUID | Unique receipt identity. |
| `cid`              | string, sha256 | Same as `manifest.cid`. |
| `artifact_hash`    | string, sha256 | Same as `manifest.artifact_hash` (computed per section 5). |
| `eval_set_hash`    | string, sha256 | Hash of the eval set used. |
| `eval_score`       | number, [0,1] | Same as `manifest.eval_score`. |
| `judge_id`         | string | Same as `manifest.judge_id`. |
| `tier`             | string, enum | Same as `manifest.tier`. |
| `chain`            | array | HMAC-sealed step chain (see below). |
| `anchors`          | array | Reserved for transparency-log anchors. v1.0 builders emit `[]`. |
| `event_source_hashes` | array of sha256 | Per-source-event hashes the seed split rolled up from. |
| `dataset_hash`     | string or null | Alias of `seed_provenance.seeds_hash`. |
| `train_hash`       | string or null | Alias of `seed_provenance.train_hash`. |
| `holdout_hash`     | string or null | Alias of `seed_provenance.holdout_hash`. |
| `split_seed`       | int or null | Alias of `seed_provenance.split_seed`. |
| `runtime_target`   | string | Same as `manifest.runtime_target`. |
| `artifact_files`   | array | Canonical-sorted `[{filename, sha256}]` over every file in the .kolm. |
| `build_toolchain`  | object | `{node_version, platform, arch, kolm_version, runtime_target, signed_at}`. |
| `signature_alg`    | string | One of `hmac-sha256`, `ed25519+hmac-sha256`, `sigstore+ed25519+hmac-sha256`. |
| `signed_at`        | string, ISO-8601 | Receipt-signing timestamp. |
| `signed_by`        | string | Either `kolm-dev-hmac-1` or `ed25519:<key_fingerprint>`. |
| `signature`        | string, hex | HMAC-SHA256 over `canonicalJson(receipt_body_without_signature)`. |
| `signature_ed25519` | object | Ed25519 block over canonical body INCLUDING the HMAC. Verifier strips it before re-canonicalizing. |
| `signature_sigstore` | object | Sigstore (cosign-compatible) bundle. Dry-run by default until `kolm sigstore-attest` pins to Rekor. |

The HMAC step chain seals build-time transitions. Each chain entry is
`{step, input_hash, output_hash, hmac}` where the HMAC is computed over
`canonicalJson({step, input_hash, output_hash})` with the build secret.
The canonical step order is: `task -> seeds -> recipes -> evals -> bundle`.

## 5. artifact_hash composition

`artifact_hash` is the sha256 of a canonical JSON over named hash slots.
The base slots, always present:

```
{
  manifest_hash,
  model_pointer_hash,
  recipes_json_hash,
  lora_bin_hash,
  index_bin_hash,
  evals_json_hash
}
```

Conditional slots — keyed ONLY when the corresponding optional payload or
block is present. v1.0 readers MUST follow the same conditional-slot rule
when recomputing the hash, otherwise pre-feature artifacts will fail
verification on a v1.0 reader that unconditionally keys every slot:

| Slot | Condition |
| ------------------------------ | --------- |
| `compiled_targets_hash`        | `compiled_targets` block present. |
| `binaries_hash`                | `binaries` non-empty array. |
| `capability_hash`              | `capability` block present (uses block's own short hash). |
| `lineage_hash`                 | `lineage` block present. |
| `export_hash`                  | `export` block present. |
| `moe_hash`                     | `moe` block present. |
| `pretokenize_hash`             | `pretokenize` block present. |
| `external_holdout_hash`        | block present. |
| `tenant_shadow_corpus_hash`    | non-empty array. |
| `auditor_attestation_hash`     | non-empty array. |
| `supersession_hash`            | block present. |
| `drift_report_hash`            | block present. |
| `workflow_ir_hash`             | `workflow_ir.json` bundled. |
| `attestation_report_hash`      | `attestation_report.json` bundled. |
| `confidential_compute_hash`    | `confidential_compute` block present (W460). |
| `mixed_precision_profile_hash` | non-empty DAQ profile array (W719). |
| `sparsity_profile_hash`        | non-empty TSAC profile object (W721). |
| `kv_profile_hash`              | non-empty ITKV profile object (W722). |
| `output_schema_hash`           | canonical schema non-null (W809). |
| `guardrails_hash`              | non-empty guardrails array (W736). |
| `parent_cid`                   | non-empty hex string (W739). |
| `region_hash`                  | non-empty region string (W769). |
| `extra_files_hash`             | any extra file bundled. |
| `recipe_bundle_mjs_hash`       | `recipe.bundle.mjs` bundled (W367). |
| `model_weights_hash`           | bundled model_weights record (W457). |

Canonical JSON in this spec means: sort object keys alphabetically, no
trailing whitespace, no NaN/Infinity, UTF-8 throughout.

## 6. Signature scheme

v1.0 supports three layered signature schemes; readers MUST verify all
present layers.

- **HMAC-SHA256** (always present). Build-time secret, mainly an integrity
  check. Receipt `signature` field is the HMAC over canonical body sans
  signature.
- **Ed25519** (default since W149). Signer key loads from
  `KOLM_ED25519_PRIVATE_KEY` env, else `~/.kolm/signing-key.pem` (auto-
  generated on first build). The `signature_ed25519` block carries
  `{algorithm:"ed25519", public_key, signature, key_fingerprint,
  signed_at, payload_canonical_sha256}`.
- **Sigstore / Rekor** (W150). Cosign-compatible bundle layered on top of
  Ed25519. Dry-run by default; `kolm sigstore-attest` upgrades to a
  Rekor-pinned bundle post-build.

The `policy` block in the manifest records signing contracts. Verifiers
MUST refuse an artifact whose declared policy is not satisfied (e.g.
`require_ed25519:true` but no `signature_ed25519` block).

## 7. Confidential compute (W460)

When an artifact is built inside a TEE, `manifest.confidential_compute` is
present with two sub-fields:

| Sub-field | Type | Meaning |
| ----------------------------- | ------ | ------- |
| `attestation_kind`            | string, enum | One of `pccs | snp-report | nitro-attestation | nras`. |
| `attestation_report_hash`     | string, sha256 | sha256 of the raw report (also bundled as `attestation_report.json`). |

The raw report bytes are opaque to this spec. A tenant registers an
attestation verifier (`registerAttestationVerifier`) and the verifier
returns `{state: "shape_ok" | "verified" | "rejected"}`. The default
state for unregistered verifiers is `shape_ok` with `verified:false`.

`confidential_compute_hash` binds the block into `artifact_hash` so any
post-build tamper of the attestation report breaks every signature.

## 8. Sustainability badge

Reserved for the W786 sustainability-badge wave. v1.0 builders MUST NOT
emit a `sustainability_badge` field. v1.0 readers MUST tolerate the field
when added by a future minor bump (1.1).

## 9. Determinism guarantees

A re-build with byte-identical inputs MUST produce a byte-identical
`artifact_hash`. The mechanisms that secure this:

1. Canonical JSON for every hashed input (sorted keys, UTF-8, no
   whitespace variance).
2. Conditional slots in `artifact_hash_input` (section 5) so adding a
   feature does not retroactively re-hash legacy artifacts.
3. Sorted extra-files list (alphabetical by filename) before hashing.
4. Fixed step order in the HMAC chain (`task -> seeds -> recipes -> evals
   -> bundle`).
5. Two-pass K-score patching (pass 1 zips without `k_score`; pass 2
   computes the size-aware K-score from the pass-1 bytes; pass 2 rezips
   with `k_score` patched in).

A reader that recomputes `artifact_hash` from the ZIP MUST match the
value declared in `manifest.artifact_hash` and the value declared in
`receipt.artifact_hash`. A mismatch is a hard verification failure.

## 10. Forward compatibility

v1.0 readers MUST preserve unknown top-level manifest fields on read and
on write. The conformance test suite includes a fixture
(`with-multimodal.manifest.json`) that exercises an unknown field; a
compliant reader must round-trip it without modification.

When a future minor bump (1.1) introduces a new optional field, v1.0
readers MUST ignore it for parsing purposes but MUST NOT strip it on
re-emit; otherwise the conditional-slot pattern would re-hash and break
signatures on a downstream v1.1 verifier.

## 11. Test vectors

Five known-good fixtures live under `tests/fixtures/format-v1/`. Each is a
small JSON manifest exercising a different combination of optional
fields. The sha256 of each fixture is recorded in
`tests/fixtures/format-v1/MANIFEST.sha256.txt`. The conformance test
(`tests/wave817-format-v1.test.js`) reads each fixture, validates it
against the schema in this document, re-hashes the bytes, and asserts
the sha256 matches the manifest.

Binary `.kolm` test vectors are out of scope for v1.0 DRAFT (no GPU on
the spec author's machine to produce a real bundle). The minimum
conformance gate is the JSON-manifest fixtures.

## 12. Compatibility table

| Reader version | Accepts v1.0.x | Accepts v1.x | Accepts v2.x |
| -------------- | -------------- | ------------ | ------------ |
| v1.0           | MUST           | SHOULD warn  | MAY refuse   |
| v1.x           | MUST           | MUST         | SHOULD warn  |
| v2.x           | SHOULD         | SHOULD       | MUST         |

Readers SHOULD log `manifest.format_version` on load. When a reader
refuses an artifact for version reasons, it MUST surface the declared
version in the rejection message so the operator can debug the mismatch
without re-opening the artifact.

## 13. Wire-format example

A minimal v1.0 manifest (no weights, no compiled targets, no attestation):

```json
{
  "spec": "kolm-1",
  "format_version": "1.0",
  "job_id": "00000000-0000-0000-0000-000000000001",
  "task": "demo.echo",
  "created_at": "2026-05-24T00:00:00.000Z",
  "runtime": "js",
  "runtime_target": "js",
  "artifact_class": "rule",
  "base_model": "Qwen/Qwen2.5-3B-Instruct",
  "tier": "recipe",
  "judge_id": "exact-match",
  "eval_score": 1.0,
  "recipes": { "n": 1, "registry_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
  "evals": { "n": 1, "spec": "kolm-evals-1", "hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
  "seed_provenance": {
    "seeds_hash": null, "split_seed": null, "holdout_ratio": 0,
    "train_hash": null, "holdout_hash": null,
    "train_count": 0, "holdout_count": 0,
    "eval_source": "self_generated", "comparator": "exact",
    "production_ready": false
  },
  "hashes": {
    "model_pointer": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "recipes_json":  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "lora_bin":      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "index_bin":     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "evals_json":    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  },
  "cid": "0000000000000000000000000000000000000000000000000000000000000001",
  "policy": { "require_ed25519": true, "require_rekor": false },
  "binaries": [],
  "compiled_binary": null,
  "production_ready": false,
  "memory_requirement_mb": 5,
  "offline_capable": true,
  "license": "Apache-2.0"
}
```

The five `tests/fixtures/format-v1/*.manifest.json` files extend this base
with the optional blocks they exercise.

## 14. References

- Canonical builder: `src/artifact.js` (compile path).
- Verifier: `src/binder.js` (rtCheck, post-build integrity sweep).
- Spec compile harness: `src/spec-compile.js`.
- Change process: `docs/spec/CHANGE_PROCESS.md`.
- Reference C reader: `sdk/c/kolm-format.h`.
- Reference Python reader: `sdk/python/kolm/format.py`.
- Reference Rust reader: `sdk/rust/src/format.rs`.
- Confidence routing: kolm runtime spec, section on confidential compute.
- K-Score calibration: `/k-score-calibration` page.
