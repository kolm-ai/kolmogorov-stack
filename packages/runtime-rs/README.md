# kolm-runtime

Native Rust verifier for `.kolm` artifacts. Loads the signed zip bundle the
Kolmogorov Stack toolchain produces, recomputes the content-id (CID),
verifies the manifest signature, the 5-step HMAC chain on the receipt, and
the receipt body signature, and exposes the manifest, receipt, and recipe
source through a small typed API. The same code compiles to a CLI binary
(`kolm-verify`), a `cdylib` for FFI hosts, a `staticlib` for embedded
deployments, and a `wasm32` module for in-browser verification.

`forbid(unsafe_code)`. Pure-Rust dependencies. No JIT, no eval, no network.

## Why a second verifier

The Node toolchain is the reference producer. Healthcare and defense
deployments need a verifier that is independent of the producing runtime
and runs on the consumer's hardware. `kolm-runtime` is that verifier:
two distinct codebases in two languages must agree byte-for-byte on
whether an artifact is genuine. If they disagree, something is wrong.

## Required toolchain

- Rust 1.75 or later, stable channel.
- For the WASM build: `rustup target add wasm32-unknown-unknown`.
- For generating browser JS glue: `cargo install wasm-bindgen-cli`.

## Quick start (Rust library)

```toml
[dependencies]
kolm-runtime = "0.2"
```

```rust
use kolm_runtime::Artifact;

fn main() -> Result<(), kolm_runtime::Error> {
    let artifact = Artifact::load_from_path("model.kolm")?;
    artifact.verify("kolm-public-fixture-v0-1-0")?;
    println!("cid = {}", artifact.cid());
    println!("k-score = {}", artifact.manifest().k_score.as_ref().unwrap().composite);
    Ok(())
}
```

For per-check output suitable for a UI, use the structured report:

```rust
let report = artifact.verify_report("kolm-public-fixture-v0-1-0");
assert!(report.ok);
println!("{}", report.to_json_pretty());
```

## Quick start (CLI)

```bash
cargo install --path packages/runtime-rs
kolm-verify model.kolm --secret-env KOLM_SECRET
```

Exit codes: `0` on full verification success, `1` on any check failure or
load failure, `2` on usage error. With `--json` the binary prints the
structured `VerifyReport` for piping into `jq` or downstream tooling.

## Quick start (WASM, browser)

```bash
cargo build --release --target wasm32-unknown-unknown --features wasm
wasm-bindgen --target web \
  --out-dir pkg \
  target/wasm32-unknown-unknown/release/kolm_runtime.wasm
```

Then in the browser:

```js
import init, { verify_bytes, cid_of, runtime_version } from "./pkg/kolm_runtime.js";

await init();
const buf = new Uint8Array(await file.arrayBuffer());
const report = JSON.parse(verify_bytes(buf, secret));
if (report.ok) {
  console.log("verified", report.cid_value);
} else {
  console.warn("failed:", report);
}
```

## API reference

### Types

- `Artifact`: a loaded, parsed `.kolm` bundle.
- `Manifest`: task descriptor, hashes, training stats, tier, embedded
  K-score.
- `Receipt`: `kolm_version`, `cid`, `artifact_hash`, `eval_set_hash`,
  `eval_score`, `judge_id`, `tier`, `chain` (5-step HMAC chain), `anchors`,
  `signature_alg`, `signed_at`, `signed_by`, `signature`.
- `ReceiptChainStep`: one step of the chain (`step`, `input_hash`,
  `output_hash`, `hmac`).
- `KScore`: composite quality score with raw axes.
- `ManifestHashes`: per-file SHA-256s used to derive the CID and
  `artifact_hash`.
- `VerifyReport`: structured per-check outcomes plus an overall `ok`
  boolean. Serializable to JSON.
- `CheckOutcome`: one check's `{ ok, reason }`.
- `TrustStore`: TOFU pin store for receipt key namespaces (in-memory,
  serializes to JSON for disk persistence).
- `Error`: granular error enum with variants for every failure mode.

### Top-level functions

- `Artifact::load_from_path(path)`: read a `.kolm` from disk.
- `Artifact::load_from_bytes(&[u8])`: read a `.kolm` from memory.
- `Artifact::verify(&secret)`: return `Ok(())` on full success, else
  `Error::VerificationFailed` with the first failing check's reason.
- `Artifact::verify_report(&secret)`: return a `VerifyReport` regardless
  of pass/fail; never errors at the IO layer.
- `Artifact::verify_with_store(&secret, &mut store)`: same as above but
  also applies TOFU pinning. First success pins the CID's `signed_by`
  namespace; subsequent calls with a different namespace fail with
  `tofu_pin`.
- `Artifact::cid()` / `artifact_hash()` / `manifest()` / `receipt()` /
  `recipes_json()` / `manifest_json_text()` / `signature_json_text()`:
  accessors.
- `canonical_json(&Value)`: canonical JSON encoder (sorted keys, no
  whitespace, recursive into arrays). Exposed because byte-identical
  canonical forms are load-bearing for verification.
- `cid_from_manifest_hashes(&ManifestHashes)`: recompute the CID from a
  manifest's hashes block.
- `verify_cid(&str, &ManifestHashes)`: check a CID string matches.
- `parse_cid(&str)`: split a CID string into version/digest/hex.

## Verification model

Each call to `verify` (or `verify_report`) runs four independent checks:

1. **CID**: `cid_from_manifest_hashes(manifest.hashes)` must equal both
   `manifest.cid` and `receipt.cid`. Guarantees the on-disk hashes block
   produces the recorded content identifier.
2. **Manifest signature**: `signature.sig` is an HMAC-SHA256 over a
   canonical JSON payload that includes the manifest hash. The verifier
   accepts either the rich payload (with `artifact_hash`, `eval_set_hash`,
   `eval_score`, `judge_id`) or the bare payload (just `manifest_hash`
   and `job_id`). Guarantees the manifest bytes on disk match what was
   signed.
3. **Receipt chain**: five HMAC-SHA256 links seal the path
   `task -> seeds -> recipes -> evals -> package`. Each link's HMAC is
   verified against the supplied secret, and each link's `input_hash` is
   checked to anchor to the prior link's `output_hash`. Guarantees the
   compile process recorded in the receipt is internally consistent.
4. **Receipt body**: HMAC-SHA256 over the canonical receipt JSON with
   the `signature` field stripped. Guarantees the receipt body and chain
   were sealed together under the same secret at issuance time.

### TOFU vs pinned key

By default, callers supply the HMAC secret directly. For deployments
where the producer's key namespace must not silently change, wrap
verification in a `TrustStore`. The first successful verification of a
CID pins its `signed_by` namespace; subsequent verifications under the
same CID must observe the same namespace, or the `tofu_pin` check fails.
Same model as SSH host keys: detect substitution after the fact, with no
PKI dependency.

## Build

The repository ships build scripts that produce native + wasm artifacts:

```bash
./build.sh            # Linux / macOS
.\build.ps1           # Windows / PowerShell
```

Both run, in order: `cargo build --release`, `cargo test --release`,
`cargo build --release --bin kolm-verify`, and (unless `--skip-wasm`)
`cargo build --release --target wasm32-unknown-unknown --features wasm`.

## Cross-compile

```bash
cargo build --release --target x86_64-unknown-linux-gnu
cargo build --release --target aarch64-unknown-linux-gnu
cargo build --release --target x86_64-apple-darwin
cargo build --release --target aarch64-apple-darwin
cargo build --release --target x86_64-pc-windows-msvc
cargo build --release --target wasm32-unknown-unknown --features wasm
```

## License

Dual-licensed under MIT or Apache-2.0 at your option (SPDX:
`MIT OR Apache-2.0`).
