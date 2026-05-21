# .kolm Artifact Format v1

Status: normative for RS-1/v0.1 artifacts.

This document is the implementation-facing format contract for third-party
readers, registries, and verifiers. It complements `docs/rs-1.md`,
`docs/manifest-v0.1.json`, and `docs/receipt-v0.1.json`.

## Compatibility

`.kolm` v1 artifacts are ZIP containers with deterministic member names,
stable JSON canonicalization, and signed receipts. Readers must ignore unknown
manifest fields and must fail closed on missing required fields, invalid hashes,
or invalid signatures.

Runtime compatibility guarantee: a v1 artifact compiled today must remain
loadable by v1-compatible runtimes for at least three years. New optional
members may be added only when older runtimes can ignore them safely.

Breaking changes require a new major format (`kolm_format_version: "2"` or
equivalent manifest field) and a migration note in `public/changelog.html`.

## ZIP Members

The canonical v1 container uses these members:

| Member | Required | Purpose |
| --- | --- | --- |
| `manifest.json` | yes | Machine-readable artifact metadata, format version, task, targets, base model, recipes, permissions, signatures, K-score, provenance. |
| `receipt.json` | yes | Signed build receipt and artifact hash inputs. |
| `evals.jsonl` | yes | Evaluation rows used for K-score. Rows must be held out from training rows. |
| `recipe.bundle.mjs` | tier-dependent | Deterministic JS recipe bundle for recipe-tier artifacts. |
| `model.gguf` | optional | GGUF runtime target when exported or distilled to llama.cpp-compatible weights. |
| `model.onnx` | optional | ONNX runtime target when exported to ONNX Runtime / OpenVINO-compatible graph. |
| `model.safetensors` | optional | Safetensors runtime target or adapter payload. |
| `model.mlpackage/` | optional | Core ML target directory. |
| `engine/` | optional | TensorRT-LLM engine target directory. |
| `mlx_model/` | optional | Apple MLX target directory. |
| `splits/train.jsonl` | provenance | Training rows or row hashes when a distill/train path was used. |
| `splits/eval.jsonl` | provenance | Held-out eval rows or row hashes when a distill/train path was used. |
| `recipe.json` | optional | Human-readable recipe metadata and schema snapshot. |
| `sig.ed25519` | optional | Detached Ed25519 signature for external verifiers. The receipt remains authoritative when absent. |
| `sbom.json` | optional | SBOM/dependency evidence for regulated deployments. |
| `attestations/*.json` | optional | Third-party auditor or confidential-compute attestations. |

All file hashes recorded in `manifest.json` or `receipt.json` are SHA-256 hex
over the exact ZIP member bytes. Directory targets are hashed as sorted
`relative_path\0sha256\0size\n` manifests.

## Manifest Rules

`manifest.json` must validate against `docs/manifest-v0.1.json` for RS-1/v0.1.
The manifest must bind:

- `kolm_version` or equivalent format version.
- artifact identity, task, base model, targets, permissions, and license.
- recipe/source hash or exported model target hashes.
- K-score and the eval rows used to compute it.
- split provenance when training or distillation was used.
- signature algorithm, signer, signature, and signing timestamp.

Implementations must use structured parsing. String search over ZIP bytes is not
a verifier.

## Signature Verification

`kolm verify <artifact.kolm>` is the reference verifier. A standalone
`kolm verify` invocation must work offline and must not require a hosted Kolm
account.

Verifiers must:

1. Load ZIP members without following path traversal entries.
2. Validate manifest and receipt JSON.
3. Recompute member hashes and artifact hash inputs.
4. Verify Ed25519/HMAC signatures according to the receipt signing mode.
5. Recompute or validate K-score provenance where eval rows are embedded.
6. Fail closed on train/eval row overlap.
7. Report warnings for optional attestations that are shape-valid but not
   cryptographically validated on the local machine.

## Registration

The public registry may add signatures, transparency-log proofs, download
counts, verified-publisher metadata, and dependency graph metadata. Registry
metadata must never be required to run or verify the base artifact offline.

## Extension Policy

New optional members must be documented in this file, covered by a verifier
check, and represented in `docs/product-sota-readiness.json` before public copy
claims the surface is complete.
