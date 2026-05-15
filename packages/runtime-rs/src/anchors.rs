//! Helpers for decoding the `anchors` array carried inside a receipt.
//!
//! Today the `anchors` field is reserved for future transparency-log
//! attestations (e.g. CT/Rekor-style inclusion proofs, AWS Nitro COSE_Sign1
//! attestation blobs, SEV-SNP binary quotes). The values are stored either
//! as hex or as base64 inside the JSON; this module surfaces both.

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde_json::Value;

/// Best-effort decoder for anchor payloads.
///
/// Walks each value in `anchors` looking for fields named `body_b64` or
/// `payload_b64` and returns the decoded bytes alongside the anchor's
/// `kind` string. Unknown anchors are skipped silently.
///
/// This crate does not interpret the bytes — that is the job of higher
/// layers (the `packages/attestation/` crate for TEE quotes, the
/// transparency-log client for Rekor proofs). What `kolm-runtime`
/// guarantees is byte-stable retrieval.
pub fn decode_anchor_blobs(anchors: &[Value]) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    for a in anchors {
        let kind = a
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        if let Some(b64) = a.get("body_b64").and_then(|v| v.as_str()) {
            if let Ok(decoded) = BASE64_STANDARD.decode(b64) {
                out.push((kind.clone(), decoded));
                continue;
            }
        }
        if let Some(b64) = a.get("payload_b64").and_then(|v| v.as_str()) {
            if let Ok(decoded) = BASE64_STANDARD.decode(b64) {
                out.push((kind, decoded));
            }
        }
    }
    out
}

/// Encode bytes as standard (RFC 4648, padding-on) base64. Re-exported so
/// callers building anchors do not need to pull base64 directly.
pub fn encode_base64(bytes: &[u8]) -> String {
    BASE64_STANDARD.encode(bytes)
}

/// Decode a standard base64 string. Returns `None` on malformed input.
pub fn decode_base64(s: &str) -> Option<Vec<u8>> {
    BASE64_STANDARD.decode(s).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trip_base64() {
        let bytes = b"hello world";
        let encoded = encode_base64(bytes);
        let decoded = decode_base64(&encoded).unwrap();
        assert_eq!(decoded, bytes);
    }

    #[test]
    fn decode_base64_bad_input() {
        assert!(decode_base64("$$$").is_none());
    }

    #[test]
    fn decode_anchors_body_b64() {
        let anchors = vec![
            json!({ "kind": "nitro", "body_b64": encode_base64(b"quote-bytes") }),
            json!({ "kind": "rekor", "payload_b64": encode_base64(b"inclusion-proof") }),
            json!({ "kind": "unknown-anchor", "junk": "no payload" }),
        ];
        let decoded = decode_anchor_blobs(&anchors);
        assert_eq!(decoded.len(), 2);
        assert_eq!(decoded[0].0, "nitro");
        assert_eq!(decoded[0].1, b"quote-bytes");
        assert_eq!(decoded[1].0, "rekor");
        assert_eq!(decoded[1].1, b"inclusion-proof");
    }
}
