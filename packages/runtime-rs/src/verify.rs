//! Signature, chain, and CID verification.
//!
//! The verification flow mirrors what `/v1/receipts/verify` does on the Node
//! side, so this crate can stand alone as an offline verifier. Inputs all
//! arrive as the literal bytes that appear inside the zip — no field
//! reconstruction from typed objects, so future schema additions do not drift
//! between the producer and the verifier.

use crate::canonical::canonical_json;
use crate::cid::{cid_from_manifest_hashes, verify_cid};
use crate::error::Error;
use crate::manifest::{Manifest, Receipt};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

/// Result of one individual verification check.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CheckOutcome {
    /// `true` when this check passed.
    pub ok: bool,
    /// Human-readable failure reason. Empty when `ok` is true.
    pub reason: String,
}

impl CheckOutcome {
    /// Construct a passing outcome.
    pub fn passed() -> Self {
        Self { ok: true, reason: String::new() }
    }
    /// Construct a failing outcome with the given reason.
    pub fn failed<S: Into<String>>(reason: S) -> Self {
        Self { ok: false, reason: reason.into() }
    }
}

/// Per-file hashes the verifier expects to find inside the zip. Compared
/// against the recomputed SHA-256s in [`check_body_hashes`].
#[derive(Debug, Clone)]
pub struct ActualBodyHashes<'a> {
    /// Hex SHA-256 of the on-disk `recipes.json` bytes.
    pub recipes_json: &'a str,
    /// Hex SHA-256 of the on-disk `lora.bin` bytes.
    pub lora_bin: &'a str,
    /// Hex SHA-256 of the on-disk `index.sqlite-vec` bytes.
    pub index_bin: &'a str,
    /// Hex SHA-256 of the on-disk `evals.json` bytes.
    pub evals_json: &'a str,
    /// Hex SHA-256 of the on-disk `model.gguf` bytes.
    pub model_pointer: &'a str,
}

/// Structured per-check report from [`crate::Artifact::verify_report`].
///
/// Each field reports a single check; `ok` is the overall conjunction.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VerifyReport {
    /// Overall pass/fail. `true` iff every individual check is `ok`.
    pub ok: bool,
    /// CID recomputation matched the stored CID (manifest + receipt).
    pub cid: CheckOutcome,
    /// Legacy `signature.sig` HMAC over the manifest hash verifies.
    pub manifest_signature: CheckOutcome,
    /// Every step of the 5-step HMAC chain verifies and anchors correctly.
    pub receipt_chain: CheckOutcome,
    /// Receipt body signature (HMAC over canonical receipt minus `signature`).
    pub receipt_body: CheckOutcome,
    /// Every file in the zip hashes to the value recorded in
    /// `manifest.hashes`. Detects post-zip tampering of payload bytes.
    pub body_hashes: CheckOutcome,
    /// TOFU pin agreement (always [`CheckOutcome::passed`] when verification
    /// is not run via a [`crate::TrustStore`]).
    pub tofu_pin: CheckOutcome,
    /// CID echoed by the report, for callers that pretty-print to JSON.
    pub cid_value: String,
    /// The receipt's `signed_by` namespace.
    pub signed_by: String,
}

impl VerifyReport {
    /// Build a fresh empty report (every check passed by default).
    pub(crate) fn new(cid: String, signed_by: String) -> Self {
        Self {
            ok: true,
            cid: CheckOutcome::passed(),
            manifest_signature: CheckOutcome::passed(),
            receipt_chain: CheckOutcome::passed(),
            receipt_body: CheckOutcome::passed(),
            body_hashes: CheckOutcome::passed(),
            tofu_pin: CheckOutcome::passed(),
            cid_value: cid,
            signed_by,
        }
    }

    /// Render as pretty JSON suitable for a CLI or HTTP response.
    pub fn to_json_pretty(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_else(|_| String::from("{}"))
    }

    /// First failing check's reason. Empty when the report is `ok`.
    pub fn first_failure_reason(&self) -> String {
        for (name, c) in [
            ("cid", &self.cid),
            ("body_hashes", &self.body_hashes),
            ("manifest_signature", &self.manifest_signature),
            ("receipt_chain", &self.receipt_chain),
            ("receipt_body", &self.receipt_body),
            ("tofu_pin", &self.tofu_pin),
        ] {
            if !c.ok {
                return format!("{}: {}", name, c.reason);
            }
        }
        String::new()
    }
}

/// Run every verification check and return a structured report. Never fails
/// at the IO layer — bad inputs fail their respective checks instead.
pub fn verify_report(
    secret: &[u8],
    manifest: &Manifest,
    manifest_json_text: &str,
    receipt: &Receipt,
    signature_json_text: &str,
    cid_value: &str,
    actual_body_hashes: Option<ActualBodyHashes<'_>>,
) -> VerifyReport {
    let mut report = VerifyReport::new(cid_value.to_string(), receipt.signed_by.clone());

    report.cid = check_cid(manifest, receipt, cid_value);
    report.manifest_signature = check_manifest_signature(secret, manifest_json_text, signature_json_text);
    report.receipt_chain = check_receipt_chain(secret, receipt);
    report.receipt_body = check_receipt_body_signature(secret, receipt);
    if let Some(actuals) = actual_body_hashes {
        report.body_hashes = check_body_hashes(manifest, &actuals);
    }

    report.ok = report.cid.ok
        && report.manifest_signature.ok
        && report.receipt_chain.ok
        && report.receipt_body.ok
        && report.body_hashes.ok
        && report.tofu_pin.ok;
    report
}

/// Verify each file's actual SHA-256 against the value recorded in
/// `manifest.hashes`. Detects post-zip tampering of any individual payload.
pub fn check_body_hashes(manifest: &Manifest, actual: &ActualBodyHashes<'_>) -> CheckOutcome {
    let h = &manifest.hashes;
    let pairs = [
        ("recipes_json", h.recipes_json.as_str(), actual.recipes_json),
        ("lora_bin", h.lora_bin.as_str(), actual.lora_bin),
        ("index_bin", h.index_bin.as_str(), actual.index_bin),
        ("evals_json", h.evals_json.as_str(), actual.evals_json),
        ("model_pointer", h.model_pointer.as_str(), actual.model_pointer),
    ];
    for (name, expected, observed) in pairs {
        if !constant_time_eq(expected.as_bytes(), observed.as_bytes()) {
            return CheckOutcome::failed(format!(
                "{} on-disk sha256 ({}) does not match manifest hash ({})",
                name, observed, expected,
            ));
        }
    }
    CheckOutcome::passed()
}

/// Legacy entry point retained for callers that just want `Ok(())` on success.
/// Returns the first failed check's reason as an
/// [`Error::VerificationFailed`].
pub fn verify_all(
    secret: &[u8],
    manifest: &Manifest,
    manifest_json_text: &str,
    receipt: &Receipt,
    signature_json_text: &str,
) -> Result<(), Error> {
    let cid_value = match manifest.cid.as_deref() {
        Some(c) => c.to_string(),
        None => cid_from_manifest_hashes(&manifest.hashes)?,
    };
    let report = verify_report(
        secret,
        manifest,
        manifest_json_text,
        receipt,
        signature_json_text,
        &cid_value,
        None,
    );
    if report.ok {
        Ok(())
    } else {
        Err(Error::VerificationFailed(report.first_failure_reason()))
    }
}

/// Compute the canonical artifact hash the same way the Node producer does.
/// Public so callers (and tests) can recompute without re-parsing the
/// manifest. Returned hex-encoded.
pub fn compute_artifact_hash(manifest: &Manifest, manifest_json_text: &str) -> String {
    let manifest_hash = hex::encode(Sha256::digest(manifest_json_text.as_bytes()));
    let v = serde_json::json!({
        "manifest_hash": manifest_hash,
        "model_pointer_hash": manifest.hashes.model_pointer,
        "recipes_json_hash":  manifest.hashes.recipes_json,
        "lora_bin_hash":      manifest.hashes.lora_bin,
        "index_bin_hash":     manifest.hashes.index_bin,
        "evals_json_hash":    manifest.hashes.evals_json,
    });
    let canon = canonical_json(&v);
    hex::encode(Sha256::digest(canon.as_bytes()))
}

fn check_cid(manifest: &Manifest, receipt: &Receipt, expected_cid: &str) -> CheckOutcome {
    let computed = match cid_from_manifest_hashes(&manifest.hashes) {
        Ok(c) => c,
        Err(e) => return CheckOutcome::failed(format!("cid compute failed: {}", e)),
    };
    if let Some(stored) = manifest.cid.as_deref() {
        if computed != stored {
            return CheckOutcome::failed(format!(
                "manifest cid mismatch: stored={} computed={}",
                stored, computed
            ));
        }
        if !verify_cid(stored, &manifest.hashes) {
            return CheckOutcome::failed("cid does not match hashes block".to_string());
        }
    }
    if let Some(rcid) = receipt.cid.as_deref() {
        if rcid != computed {
            return CheckOutcome::failed(format!(
                "receipt cid mismatch: receipt={} computed={}",
                rcid, computed
            ));
        }
    }
    if expected_cid != computed {
        return CheckOutcome::failed(format!(
            "expected cid mismatch: expected={} computed={}",
            expected_cid, computed
        ));
    }
    CheckOutcome::passed()
}

fn check_manifest_signature(
    secret: &[u8],
    manifest_json_text: &str,
    signature_json_text: &str,
) -> CheckOutcome {
    let manifest_hash = hex::encode(Sha256::digest(manifest_json_text.as_bytes()));
    let sig: Value = match serde_json::from_str(signature_json_text) {
        Ok(v) => v,
        Err(e) => return CheckOutcome::failed(format!("signature.sig json parse: {}", e)),
    };
    let sig_spec = sig.get("spec").and_then(|v| v.as_str()).unwrap_or("");
    if sig_spec != "kolm-1" {
        return CheckOutcome::failed(format!(
            "signature.sig has unexpected spec: {}",
            sig_spec
        ));
    }
    let stored_manifest_hash = match sig.get("manifest_hash").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return CheckOutcome::failed("signature.sig missing manifest_hash".into()),
    };
    if stored_manifest_hash != manifest_hash {
        return CheckOutcome::failed("signature.sig manifest_hash mismatch".into());
    }
    let stored_hmac = match sig.get("hmac").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return CheckOutcome::failed("signature.sig missing hmac".into()),
    };
    // The Node side accepts either the rich payload (with artifact_hash et al)
    // or the bare payload. Match both.
    let bare = serde_json::json!({
        "spec": "kolm-1",
        "manifest_hash": manifest_hash,
        "job_id": sig.get("job_id"),
    });
    let rich = serde_json::json!({
        "spec": "kolm-1",
        "manifest_hash": manifest_hash,
        "job_id": sig.get("job_id"),
        "artifact_hash": sig.get("artifact_hash"),
        "eval_set_hash": sig.get("eval_set_hash"),
        "eval_score": sig.get("eval_score"),
        "judge_id": sig.get("judge_id"),
    });
    for payload in [&rich, &bare] {
        let body = canonical_json(payload);
        let mut mac = match HmacSha256::new_from_slice(secret) {
            Ok(m) => m,
            Err(_) => return CheckOutcome::failed("hmac key init failed".into()),
        };
        mac.update(body.as_bytes());
        let expected = hex::encode(mac.finalize().into_bytes());
        if constant_time_eq(expected.as_bytes(), stored_hmac.as_bytes()) {
            return CheckOutcome::passed();
        }
    }
    CheckOutcome::failed("signature.sig hmac mismatch".into())
}

fn check_receipt_chain(secret: &[u8], receipt: &Receipt) -> CheckOutcome {
    if receipt.chain.is_empty() {
        return CheckOutcome::failed("receipt chain empty".into());
    }
    for (i, link) in receipt.chain.iter().enumerate() {
        let v = serde_json::json!({
            "step": link.step,
            "input_hash": link.input_hash,
            "output_hash": link.output_hash,
        });
        let body = canonical_json(&v);
        let mut mac = match HmacSha256::new_from_slice(secret) {
            Ok(m) => m,
            Err(_) => return CheckOutcome::failed("hmac key init failed".into()),
        };
        mac.update(body.as_bytes());
        let expected = hex::encode(mac.finalize().into_bytes());
        if !constant_time_eq(expected.as_bytes(), link.hmac.as_bytes()) {
            return CheckOutcome::failed(format!("chain[{}] ({}) hmac mismatch", i, link.step));
        }
        if i > 0 && link.input_hash != receipt.chain[i - 1].output_hash {
            return CheckOutcome::failed(format!(
                "chain[{}] ({}) input_hash does not anchor to chain[{}]",
                i,
                link.step,
                i - 1
            ));
        }
    }
    CheckOutcome::passed()
}

fn check_receipt_body_signature(secret: &[u8], receipt: &Receipt) -> CheckOutcome {
    let signature = match receipt.signature.as_deref() {
        Some(s) => s,
        None => return CheckOutcome::failed("receipt body signature missing".into()),
    };
    let mut v = match serde_json::to_value(receipt) {
        Ok(v) => v,
        Err(e) => return CheckOutcome::failed(format!("receipt serialize: {}", e)),
    };
    if let Some(obj) = v.as_object_mut() {
        obj.remove("signature");
    }
    let canon = canonical_json(&v);
    let mut mac = match HmacSha256::new_from_slice(secret) {
        Ok(m) => m,
        Err(_) => return CheckOutcome::failed("hmac key init failed".into()),
    };
    mac.update(canon.as_bytes());
    let expected = hex::encode(mac.finalize().into_bytes());
    if constant_time_eq(expected.as_bytes(), signature.as_bytes()) {
        CheckOutcome::passed()
    } else {
        CheckOutcome::failed("receipt body signature mismatch".into())
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_outcome_passed_is_ok() {
        let o = CheckOutcome::passed();
        assert!(o.ok);
        assert!(o.reason.is_empty());
    }

    #[test]
    fn check_outcome_failed_carries_reason() {
        let o = CheckOutcome::failed("boom");
        assert!(!o.ok);
        assert_eq!(o.reason, "boom");
    }

    #[test]
    fn report_first_failure_finds_the_failing_check() {
        let mut r = VerifyReport::new("cidv1:sha256:abc".into(), "kolm-dev-hmac-1".into());
        r.receipt_chain = CheckOutcome::failed("chain[2] hmac mismatch");
        r.ok = false;
        assert_eq!(
            r.first_failure_reason(),
            "receipt_chain: chain[2] hmac mismatch"
        );
    }

    #[test]
    fn constant_time_eq_safety() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(!constant_time_eq(b"", b"x"));
    }
}
