//! Content-identifier (CID) computation — mirror of `src/cid.js`.
//!
//! Format: `cidv1:sha256:<64-hex>`. Computed deterministically from a
//! manifest's `hashes` block:
//!
//! ```text
//! canonical_json({
//!   digest: "sha256",
//!   parts: {
//!     model_pointer: <hex>,
//!     recipes_json:  <hex>,
//!     lora_bin:      <hex>,
//!     index_bin:     <hex>,
//!     evals_json:    <hex>,
//!   }
//! }) → sha256 → "cidv1:sha256:<hex>"
//! ```
//!
//! Same inputs always produce the same CID; any byte difference in any of
//! the five per-file hashes changes the CID. The CID is independent of the
//! receipt signature, K-score, and tenant secret rotation.

use crate::canonical::canonical_json;
use crate::error::Error;
use crate::manifest::ManifestHashes;
use sha2::{Digest, Sha256};

/// The CID version string this crate emits.
pub const CID_VERSION: &str = "cidv1";

/// The digest name this crate emits.
pub const CID_DIGEST: &str = "sha256";

/// Compute a CID from a `ManifestHashes` block.
pub fn cid_from_manifest_hashes(h: &ManifestHashes) -> Result<String, Error> {
    validate_hex64("model_pointer", &h.model_pointer)?;
    validate_hex64("recipes_json", &h.recipes_json)?;
    validate_hex64("lora_bin", &h.lora_bin)?;
    validate_hex64("index_bin", &h.index_bin)?;
    validate_hex64("evals_json", &h.evals_json)?;

    let v = serde_json::json!({
        "digest": CID_DIGEST,
        "parts": {
            "model_pointer": h.model_pointer,
            "recipes_json":  h.recipes_json,
            "lora_bin":      h.lora_bin,
            "index_bin":     h.index_bin,
            "evals_json":    h.evals_json,
        }
    });
    let canon = canonical_json(&v);
    let mut hasher = Sha256::new();
    hasher.update(canon.as_bytes());
    let digest = hex::encode(hasher.finalize());
    Ok(format!("{}:{}:{}", CID_VERSION, CID_DIGEST, digest))
}

/// Verify a CID string against a `ManifestHashes` block. Returns `true` iff
/// the recomputed CID matches, `false` otherwise.
pub fn verify_cid(cid: &str, hashes: &ManifestHashes) -> bool {
    match cid_from_manifest_hashes(hashes) {
        Ok(computed) => computed == cid,
        Err(_) => false,
    }
}

/// Components of a parsed CID — version, digest, hex.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCid {
    /// CID version (e.g. `cidv1`).
    pub version: String,
    /// Digest algorithm (e.g. `sha256`).
    pub digest: String,
    /// Hex-encoded digest body.
    pub hex: String,
}

/// Parse a CID string. Returns `None` on malformed input.
pub fn parse_cid(s: &str) -> Option<ParsedCid> {
    let parts: Vec<&str> = s.splitn(3, ':').collect();
    if parts.len() != 3 {
        return None;
    }
    if !parts[0].starts_with("cidv") || parts[0].len() < 5 {
        return None;
    }
    if parts[1].is_empty() || !parts[1].chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    if parts[2].is_empty() || !parts[2].chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(ParsedCid {
        version: parts[0].to_string(),
        digest: parts[1].to_string(),
        hex: parts[2].to_string(),
    })
}

fn validate_hex64(field: &str, s: &str) -> Result<(), Error> {
    if s.len() != 64 || !s.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) {
        return Err(Error::MalformedManifest(format!(
            "hashes.{} must be 64-char lowercase hex sha256",
            field
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(byte: char) -> String {
        std::iter::repeat(byte).take(64).collect()
    }

    fn fixture() -> ManifestHashes {
        ManifestHashes {
            model_pointer: h('a'),
            recipes_json: h('b'),
            lora_bin: h('c'),
            index_bin: h('d'),
            evals_json: h('e'),
        }
    }

    #[test]
    fn produces_cidv1_sha256() {
        let cid = cid_from_manifest_hashes(&fixture()).unwrap();
        assert!(cid.starts_with("cidv1:sha256:"));
        assert_eq!(cid.len(), "cidv1:sha256:".len() + 64);
    }

    #[test]
    fn deterministic() {
        let a = cid_from_manifest_hashes(&fixture()).unwrap();
        let b = cid_from_manifest_hashes(&fixture()).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn changes_when_any_input_changes() {
        let base = cid_from_manifest_hashes(&fixture()).unwrap();
        let mut m = fixture();
        m.evals_json = h('f');
        assert_ne!(cid_from_manifest_hashes(&m).unwrap(), base);
    }

    #[test]
    fn rejects_malformed_hex() {
        let mut m = fixture();
        m.evals_json = "too-short".to_string();
        assert!(cid_from_manifest_hashes(&m).is_err());
    }

    #[test]
    fn verify_cid_passes_on_match() {
        let cid = cid_from_manifest_hashes(&fixture()).unwrap();
        assert!(verify_cid(&cid, &fixture()));
    }

    #[test]
    fn verify_cid_fails_on_mismatch() {
        assert!(!verify_cid(
            "cidv1:sha256:0000000000000000000000000000000000000000000000000000000000000000",
            &fixture()
        ));
    }

    #[test]
    fn parse_cid_valid() {
        let cid = cid_from_manifest_hashes(&fixture()).unwrap();
        let parsed = parse_cid(&cid).unwrap();
        assert_eq!(parsed.version, "cidv1");
        assert_eq!(parsed.digest, "sha256");
    }

    #[test]
    fn parse_cid_invalid() {
        assert!(parse_cid("").is_none());
        assert!(parse_cid("cidv1:sha256:").is_none());
        assert!(parse_cid("bad").is_none());
        assert!(parse_cid("cidv1:sha256:XYZ").is_none());
    }
}
