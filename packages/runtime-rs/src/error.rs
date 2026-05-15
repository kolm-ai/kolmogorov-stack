//! Crate error type.
//!
//! Errors are intentionally granular so callers (CLI tools, FFI bridges, web
//! UIs) can branch on the specific failure mode rather than parsing strings.

use thiserror::Error;

/// All failure modes for loading and verifying a `.kolm` artifact.
#[derive(Debug, Error)]
pub enum Error {
    /// IO error reading the artifact file.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// Zip parse error.
    #[error("zip error: {0}")]
    Zip(#[from] zip::result::ZipError),

    /// Required file missing from the zip.
    #[error("required artifact file missing: {0}")]
    MissingFile(String),

    /// JSON parse error.
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    /// File contents are not valid UTF-8.
    #[error("invalid utf-8 in artifact file: {0}")]
    Utf8(#[from] std::string::FromUtf8Error),

    /// Manifest is well-formed JSON but missing required fields or
    /// containing fields with malformed values (e.g. non-hex hashes).
    #[error("malformed manifest: {0}")]
    MalformedManifest(String),

    /// A SHA-256 over manifest, recipes, or evals bytes did not match the
    /// value recorded in the manifest's `hashes` block.
    #[error("hash mismatch: {0}")]
    HashMismatch(String),

    /// Receipt HMAC chain is broken — either an individual step's HMAC does
    /// not verify or a step's `input_hash` does not anchor to the prior
    /// step's `output_hash`.
    #[error("receipt chain broken: {0}")]
    ReceiptChainBroken(String),

    /// The receipt body HMAC or the legacy `signature.sig` HMAC did not
    /// verify under the supplied secret.
    #[error("signature mismatch: {0}")]
    SignatureMismatch(String),

    /// The CID stored on the manifest or receipt did not match the CID
    /// recomputed from the manifest's `hashes` block.
    #[error("cid mismatch: {0}")]
    CidMismatch(String),

    /// A TOFU-pinned key namespace disagreed with the receipt's `signed_by`.
    #[error("tofu pin mismatch: {0}")]
    TofuPinMismatch(String),

    /// Generic verification failure when the call site does not need to
    /// distinguish between the more specific variants above.
    #[error("verification failed: {0}")]
    VerificationFailed(String),
}
