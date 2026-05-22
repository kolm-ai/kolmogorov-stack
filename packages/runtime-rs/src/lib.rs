//! # kolm-runtime
//!
//! Native Rust runtime for `.kolm` artifacts. Parses the signed zip bundle
//! produced by the Node toolchain, verifies the manifest signature and the
//! 5-step HMAC chain on the receipt, recomputes the content-id (CID), and
//! exposes the manifest, receipt, and recipe source through a small typed API.
//!
//! ## What this crate does
//!
//! - Reads a `.kolm` zip from disk or memory.
//! - Recomputes the CID from the manifest's per-file hashes and confirms it
//!   matches `manifest.cid` and `receipt.cid`.
//! - Verifies `manifest.json` against `signature.sig` (legacy HMAC-SHA256).
//! - Verifies `receipt.json` body signature.
//! - Verifies every step of the 5-step receipt HMAC chain
//!   (`task -> seeds -> recipes -> evals -> package`).
//! - Returns a structured [`VerifyReport`] so callers can show which check
//!   failed instead of getting a single opaque error.
//! - Supports trust-on-first-use (TOFU) key pinning via [`TrustStore`].
//!
//! ## What this crate deliberately does NOT do
//!
//! - Execute recipes. The recipe `source` field carries JavaScript that runs
//!   in a higher-layer engine (wasmtime, V8 isolate, QuickJS). This crate
//!   only reads and verifies; the execution layer plugs in separately.
//! - Resolve LoRA or base-model weights. The manifest carries a pointer to
//!   the base model; weight fetching lives in the runner.
//!
//! ## Cross-compile targets
//!
//! The crate is `#![forbid(unsafe_code)]` and uses only pure-Rust deps so it
//! builds out of the box for:
//!
//! - `x86_64-unknown-linux-gnu` / `aarch64-unknown-linux-gnu` (servers)
//! - `aarch64-apple-darwin` / `x86_64-apple-darwin` (macOS CLI)
//! - `x86_64-pc-windows-msvc` (Windows CLI)
//! - `wasm32-unknown-unknown` (browser verifier, with `--features wasm`)
//!
//! ## Quick start
//!
//! ```no_run
//! use kolm_runtime::Artifact;
//!
//! let artifact = Artifact::load_from_path("model.kolm")?;
//! let report = artifact.verify_report("kolm-public-fixture-v0-1-0");
//! assert!(report.ok, "verification failed: {:?}", report);
//! println!("cid = {}", artifact.cid());
//! # Ok::<(), kolm_runtime::Error>(())
//! ```
//!
//! ## Verification model
//!
//! By default callers pass the HMAC secret directly. For deployments that
//! want trust-on-first-use semantics, wrap calls in [`TrustStore`]: the first
//! verified artifact pins its `signed_by` key namespace, and subsequent
//! artifacts must match.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![cfg_attr(docsrs, feature(doc_cfg))]

pub mod anchors;
pub mod canonical;
pub mod cid;
pub mod error;
pub mod manifest;
pub mod tofu;
pub mod verify;
pub mod zip_reader;

#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
#[cfg_attr(docsrs, doc(cfg(feature = "wasm")))]
pub mod wasm;

pub use canonical::canonical_json;
pub use cid::{cid_from_manifest_hashes, parse_cid, verify_cid, ParsedCid, CID_DIGEST, CID_VERSION};
pub use error::Error;
pub use manifest::{
    KScore, Manifest, ManifestEvals, ManifestHashes, ManifestRecipes, Receipt, ReceiptChainStep,
};
pub use tofu::{TrustEntry, TrustStore};
pub use verify::{ActualBodyHashes, CheckOutcome, VerifyReport};

use std::path::Path;

/// A loaded, parsed `.kolm` artifact.
///
/// Construct with [`Artifact::load_from_path`] or [`Artifact::load_from_bytes`].
/// Call [`Artifact::verify`] (or [`Artifact::verify_report`] for structured
/// output) to check the signature, the receipt chain, the body signature, and
/// the CID before trusting any embedded content.
#[derive(Debug, Clone)]
pub struct Artifact {
    manifest: Manifest,
    receipt: Receipt,
    recipes_json: String,
    signature_json: String,
    manifest_json: String,
    cid: String,
    /// SHA-256 of the canonical artifact body — the same value that lands in
    /// `receipt.artifact_hash`. Computed from the in-zip hashes block.
    artifact_hash_canonical: String,
    /// SHA-256 of the actual in-zip recipes.json bytes, used to detect
    /// post-zip tampering of the recipes payload.
    recipes_json_actual_sha256: String,
    /// SHA-256 of the actual in-zip lora.bin bytes.
    lora_bin_actual_sha256: String,
    /// SHA-256 of the actual in-zip index.sqlite-vec bytes.
    index_bin_actual_sha256: String,
    /// SHA-256 of the actual in-zip evals.json bytes.
    evals_json_actual_sha256: String,
    /// SHA-256 of the actual in-zip model.gguf bytes.
    model_pointer_actual_sha256: String,
}

impl Artifact {
    /// Load an artifact from a file path. Returns [`Error::Io`] on a missing
    /// file, [`Error::Zip`] on a malformed bundle, or [`Error::MissingFile`]
    /// if a required entry is missing.
    pub fn load_from_path<P: AsRef<Path>>(path: P) -> Result<Self, Error> {
        let bytes = std::fs::read(path.as_ref()).map_err(Error::Io)?;
        Self::load_from_bytes(&bytes)
    }

    /// Load an artifact from an in-memory zip buffer.
    pub fn load_from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        use sha2::{Digest, Sha256};
        let files = zip_reader::read_artifact_files(bytes)?;
        let manifest_json = files
            .get("manifest.json")
            .ok_or_else(|| Error::MissingFile("manifest.json".into()))?
            .clone();
        let manifest: Manifest = serde_json::from_slice(&manifest_json).map_err(Error::Json)?;
        let recipes_json_bytes = files
            .get("recipes.json")
            .ok_or_else(|| Error::MissingFile("recipes.json".into()))?
            .clone();
        let signature_json_bytes = files
            .get("signature.sig")
            .ok_or_else(|| Error::MissingFile("signature.sig".into()))?
            .clone();
        let receipt_bytes = files
            .get("receipt.json")
            .ok_or_else(|| Error::MissingFile("receipt.json".into()))?
            .clone();
        let receipt: Receipt = serde_json::from_slice(&receipt_bytes).map_err(Error::Json)?;
        let recipes_json = String::from_utf8(recipes_json_bytes.clone()).map_err(Error::Utf8)?;
        let signature_json = String::from_utf8(signature_json_bytes).map_err(Error::Utf8)?;
        let manifest_str = String::from_utf8(manifest_json.clone()).map_err(Error::Utf8)?;
        let cid = match &manifest.cid {
            Some(c) => c.clone(),
            None => crate::cid::cid_from_manifest_hashes(&manifest.hashes)?,
        };
        let artifact_hash_canonical = verify::compute_artifact_hash(&manifest, &manifest_str);
        // Re-hash every payload file the manifest tracks so verify_report can
        // detect post-zip tampering of any individual entry.
        let recipes_json_actual_sha256 = hex::encode(Sha256::digest(&recipes_json_bytes));
        let lora_bin_actual_sha256 = hex::encode(Sha256::digest(
            files.get("lora.bin").map(Vec::as_slice).unwrap_or(&[]),
        ));
        let index_bin_actual_sha256 = hex::encode(Sha256::digest(
            files.get("index.sqlite-vec").map(Vec::as_slice).unwrap_or(&[]),
        ));
        let evals_json_actual_sha256 = hex::encode(Sha256::digest(
            files.get("evals.json").map(Vec::as_slice).unwrap_or(&[]),
        ));
        let model_pointer_actual_sha256 = hex::encode(Sha256::digest(
            files.get("model.gguf").map(Vec::as_slice).unwrap_or(&[]),
        ));
        Ok(Self {
            manifest,
            receipt,
            recipes_json,
            signature_json,
            manifest_json: manifest_str,
            cid,
            artifact_hash_canonical,
            recipes_json_actual_sha256,
            lora_bin_actual_sha256,
            index_bin_actual_sha256,
            evals_json_actual_sha256,
            model_pointer_actual_sha256,
        })
    }

    /// Verify the artifact against `secret` — the tenant's receipt HMAC key.
    ///
    /// Checks performed:
    ///
    /// 1. Recomputed CID over `manifest.hashes` matches the stored CID
    ///    (both on the manifest and on the receipt).
    /// 2. Legacy `signature.sig` HMAC over the manifest hash verifies.
    /// 3. Each step of the receipt's 5-step HMAC chain verifies, and each
    ///    step's `input_hash` anchors to the prior step's `output_hash`.
    /// 4. Receipt body signature over the canonical receipt (with
    ///    `signature` stripped) verifies under the secret.
    ///
    /// On success returns `Ok(())`. On failure returns the first failed check
    /// as an [`Error::VerificationFailed`] with a human-readable reason. For
    /// structured output that reports every check independently, use
    /// [`Artifact::verify_report`].
    pub fn verify(&self, secret: &str) -> Result<(), Error> {
        let report = self.verify_report(secret);
        if report.ok {
            Ok(())
        } else {
            Err(Error::VerificationFailed(report.first_failure_reason()))
        }
    }

    /// Run every verification check and return a structured [`VerifyReport`].
    ///
    /// Unlike [`Artifact::verify`], this method always returns `Ok` from the
    /// I/O perspective — failures land in `report.ok = false` with per-check
    /// outcomes. Useful for UIs that want to render a green/red checklist.
    pub fn verify_report(&self, secret: &str) -> VerifyReport {
        let actuals = verify::ActualBodyHashes {
            recipes_json: &self.recipes_json_actual_sha256,
            lora_bin: &self.lora_bin_actual_sha256,
            index_bin: &self.index_bin_actual_sha256,
            evals_json: &self.evals_json_actual_sha256,
            model_pointer: &self.model_pointer_actual_sha256,
        };
        verify::verify_report(
            secret.as_bytes(),
            &self.manifest,
            &self.manifest_json,
            &self.receipt,
            &self.signature_json,
            &self.cid,
            Some(actuals),
        )
    }

    /// Verify under a [`TrustStore`] applying TOFU semantics: the first call
    /// records the receipt's `signed_by` key namespace, and subsequent calls
    /// must match.
    ///
    /// Returns the [`VerifyReport`] (always populated) and mutates the store
    /// on success to pin the namespace for this CID.
    pub fn verify_with_store(&self, secret: &str, store: &mut TrustStore) -> VerifyReport {
        let mut report = self.verify_report(secret);
        // Check existing pin BEFORE observing, otherwise the call would pin
        // and then immediately compare against itself.
        let prior_pin = store
            .get_pinned_namespace(&self.cid)
            .map(str::to_string);
        if let Some(pinned) = prior_pin {
            if pinned != self.receipt.signed_by {
                report.ok = false;
                report.tofu_pin = CheckOutcome::failed(format!(
                    "tofu pin mismatch: stored={} observed={}",
                    pinned, self.receipt.signed_by
                ));
                return report;
            }
        }
        if report.ok {
            store.observe(&self.cid, &self.receipt.signed_by, &report);
        }
        report
    }

    /// The content-id (CID) of this artifact, in the form
    /// `cidv1:sha256:<64-hex>`.
    pub fn cid(&self) -> &str {
        &self.cid
    }

    /// SHA-256 of the canonical artifact body that the receipt covers.
    /// Returned hex-encoded.
    pub fn artifact_hash(&self) -> &str {
        &self.artifact_hash_canonical
    }

    /// The parsed manifest.
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    /// The parsed receipt (chain + signatures + anchors).
    pub fn receipt(&self) -> &Receipt {
        &self.receipt
    }

    /// The raw `recipes.json` body as UTF-8 (recipe execution lives in a
    /// higher layer; this crate only reads).
    pub fn recipes_json(&self) -> &str {
        &self.recipes_json
    }

    /// The raw `manifest.json` text exactly as it appears inside the zip.
    /// Surfaced for callers that want to recompute hashes themselves without
    /// re-serializing the parsed struct.
    pub fn manifest_json_text(&self) -> &str {
        &self.manifest_json
    }

    /// The raw `signature.sig` text exactly as it appears inside the zip.
    pub fn signature_json_text(&self) -> &str {
        &self.signature_json
    }
}

/// Crate version string, surfaced to FFI callers that need to gate on a
/// specific runtime build.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_json_round_trips_via_serde() {
        let v = json!({
            "task": "spam-detect",
            "params": [1, 2, 3],
            "nested": { "z": true, "a": null },
        });
        let canon = canonical_json(&v);
        let parsed: serde_json::Value = serde_json::from_str(&canon).expect("round-trip");
        assert_eq!(parsed, v);
    }

    #[test]
    fn canonical_json_sorts_keys() {
        let v = json!({ "b": 1, "a": 2, "c": 3 });
        assert_eq!(canonical_json(&v), r#"{"a":2,"b":1,"c":3}"#);
    }

    #[test]
    fn canonical_json_recurses_into_arrays() {
        // The Kolm v10b regression case: array elements must be
        // canonicalized too, not stringified as-is.
        let v = json!([{ "z": 1, "a": 2 }, { "y": 3, "b": 4 }]);
        assert_eq!(canonical_json(&v), r#"[{"a":2,"z":1},{"b":4,"y":3}]"#);
    }

    #[test]
    fn version_string_is_non_empty() {
        assert!(!version().is_empty());
    }
}
