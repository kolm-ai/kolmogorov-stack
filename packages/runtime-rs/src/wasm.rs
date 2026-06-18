//! `wasm32-unknown-unknown` bindings, gated behind the `wasm` cargo feature.
//!
//! Build with:
//!
//! ```text
//! cargo build --release --target wasm32-unknown-unknown --features wasm
//! ```
//!
//! Then run `wasm-bindgen` over the output to generate JS glue:
//!
//! ```text
//! wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/kolm_runtime.wasm
//! ```
//!
//! The browser side then consumes it as:
//!
//! ```js
//! import init, { verify_bytes } from "./pkg/kolm_runtime.js";
//! await init();
//! const report = JSON.parse(verify_bytes(new Uint8Array(kolmFileBytes), secret));
//! if (report.ok) console.log("verified");
//! ```

use crate::zip_reader::ZipReadLimits;
use crate::{Artifact, CheckOutcome, Error, VerifyReport};
use wasm_bindgen::prelude::*;

/// Browser binding contract version pinned by the JS-side release tests.
pub const WASM_CONTRACT_VERSION: &str = "w928-runtime-rs-wasm-v1";
/// Maximum artifact buffer accepted by browser-facing wasm bindings.
pub const WASM_MAX_ARTIFACT_BYTES: usize = 64 * 1024 * 1024;
/// Maximum zip entries accepted by browser-facing wasm bindings.
pub const WASM_MAX_ZIP_ENTRIES: usize = 64;
/// Maximum uncompressed bytes accepted for one browser artifact entry.
pub const WASM_MAX_ZIP_ENTRY_BYTES: u64 = 32 * 1024 * 1024;
/// Maximum total uncompressed bytes accepted for a browser artifact.
pub const WASM_MAX_ZIP_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
/// Maximum UTF-8 bytes accepted for the verification secret.
pub const WASM_MAX_SECRET_BYTES: usize = 4096;

/// Verify a `.kolm` byte buffer against `secret` and return the structured
/// [`VerifyReport`] as JSON text. Errors during load are converted into a
/// failing report so the JS caller only needs to branch on `ok`.
#[wasm_bindgen]
pub fn verify_bytes(bytes: &[u8], secret: &str) -> String {
    if let Err(reason) = validate_wasm_inputs(bytes, secret) {
        return failed_report(reason).to_json_pretty();
    }

    match Artifact::load_from_bytes_with_limits(bytes, browser_zip_limits()) {
        Ok(a) => a.verify_report(secret).to_json_pretty(),
        Err(e) => failed_report(classify_load_error(&e)).to_json_pretty(),
    }
}

/// Return the artifact's CID without verifying. Useful for UI previews.
#[wasm_bindgen]
pub fn cid_of(bytes: &[u8]) -> Result<String, JsError> {
    if bytes.len() > WASM_MAX_ARTIFACT_BYTES {
        return Err(JsError::new("artifact_too_large"));
    }
    let a = Artifact::load_from_bytes_with_limits(bytes, browser_zip_limits())
        .map_err(|e| JsError::new(classify_load_error(&e)))?;
    Ok(a.cid().to_string())
}

/// Return the crate version string.
#[wasm_bindgen]
pub fn runtime_version() -> String {
    crate::version().to_string()
}

/// Return the wasm binding contract version string.
#[wasm_bindgen]
pub fn wasm_contract_version() -> String {
    WASM_CONTRACT_VERSION.to_string()
}

/// Return browser resource limits as compact JSON for UI guardrails.
#[wasm_bindgen]
pub fn wasm_limits_json() -> String {
    serde_json::json!({
        "contract_version": WASM_CONTRACT_VERSION,
        "max_artifact_bytes": WASM_MAX_ARTIFACT_BYTES,
        "max_zip_entries": WASM_MAX_ZIP_ENTRIES,
        "max_zip_entry_bytes": WASM_MAX_ZIP_ENTRY_BYTES,
        "max_zip_total_bytes": WASM_MAX_ZIP_TOTAL_BYTES,
        "max_secret_bytes": WASM_MAX_SECRET_BYTES,
    })
    .to_string()
}

fn browser_zip_limits() -> ZipReadLimits {
    ZipReadLimits {
        max_entries: WASM_MAX_ZIP_ENTRIES,
        max_entry_bytes: WASM_MAX_ZIP_ENTRY_BYTES,
        max_total_bytes: WASM_MAX_ZIP_TOTAL_BYTES,
    }
}

fn validate_wasm_inputs(bytes: &[u8], secret: &str) -> Result<(), &'static str> {
    if bytes.len() > WASM_MAX_ARTIFACT_BYTES {
        return Err("artifact_too_large");
    }
    if secret.is_empty() {
        return Err("secret_missing");
    }
    if secret.len() > WASM_MAX_SECRET_BYTES {
        return Err("secret_too_large");
    }
    Ok(())
}

fn failed_report(reason: &str) -> VerifyReport {
    let mut report = VerifyReport::new(String::new(), String::new());
    report.ok = false;
    report.cid = CheckOutcome::failed(reason);
    report
}

fn classify_load_error(error: &Error) -> &'static str {
    match error {
        Error::Io(_) => "artifact_io_error",
        Error::Zip(_) => "artifact_zip_parse_failed",
        Error::MissingFile(_) => "artifact_missing_required_file",
        Error::Json(_) => "artifact_json_parse_failed",
        Error::Utf8(_) => "artifact_utf8_decode_failed",
        Error::MalformedManifest(reason) if reason.contains("limit") => {
            "artifact_resource_limit_exceeded"
        }
        Error::MalformedManifest(reason) if reason.contains("duplicate zip entry") => {
            "artifact_duplicate_zip_entry"
        }
        Error::MalformedManifest(reason) if reason.contains("unsafe zip entry") => {
            "artifact_unsafe_zip_entry"
        }
        Error::MalformedManifest(_) => "artifact_malformed_manifest",
        Error::HashMismatch(_) => "artifact_hash_mismatch",
        Error::ReceiptChainBroken(_) => "artifact_receipt_chain_broken",
        Error::SignatureMismatch(_) => "artifact_signature_mismatch",
        Error::CidMismatch(_) => "artifact_cid_mismatch",
        Error::TofuPinMismatch(_) => "artifact_tofu_pin_mismatch",
        Error::VerificationFailed(_) => "artifact_verification_failed",
    }
}
