//! kolm artifact format v1.0 reference reader (Rust).
//!
//! Pure-Rust implementation of the .kolm artifact format v1.0 specified in
//! `docs/spec/kolm-format-v1.0.md`. Uses `serde` and `serde_json` (already
//! deps of the `kolm` crate); the ZIP layer is intentionally pluggable so
//! readers can drop in `zip = "0.6"` or `async_zip` as appropriate.
//!
//! ## Honesty contract
//!
//! - Every field name on the structs below MUST match the JSON key used
//!   in manifest.json / receipt.json verbatim. The v1.0 spec enforces
//!   field-name parity across C / Python / Rust SDKs (see
//!   `tests/wave817-format-v1.test.js` for the parity gate).
//! - Optional fields are `Option<T>`. Callers MUST distinguish `None`
//!   (absent) from `Some(default)` (present but empty) — the
//!   conditional-slot pattern in section 5 of the spec depends on it.
//! - Hashes are stored as 64-char lowercase hex strings. [`EMPTY_SHA`]
//!   (sha256 of zero bytes) is the explicit honest-empty marker.
//! - [`FormatError`] carries a `code` matching the `FormatErrorCode`
//!   enum in `sdk/python/kolm/format.py` and `kolm_format_error_t` in
//!   `sdk/c/kolm-format.h`.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Spec marker every v1.0 manifest declares as the value of `spec`.
pub const KOLM_FORMAT_SPEC: &str = "kolm-1";

/// Default declared `format_version` for v1.0 manifests.
pub const KOLM_FORMAT_VERSION: &str = "1.0";

/// sha256 of zero bytes — honest-empty marker for absent payloads.
pub const EMPTY_SHA: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// Required top-level entries on every v1.0 .kolm ZIP per spec §2.
pub const REQUIRED_ENTRIES: &[&str] = &[
    "manifest.json",
    "recipes.json",
    "evals.json",
    "signature.sig",
    "receipt.json",
    "credential.json",
];

/// Enumerated `artifact_class` values per spec §3.
pub const ARTIFACT_CLASSES: &[&str] = &[
    "rule",
    "synthesized_rule",
    "compiled_rule",
    "distilled_model",
];

/// Enumerated `runtime_target` values per spec §3.
pub const RUNTIME_TARGETS: &[&str] = &["js", "gguf", "onnx", "wasm", "native"];

/// Enumerated `tier` values per spec §3.
pub const TIERS: &[&str] = &["recipe", "adapter", "specialist", "bundle"];

/// Enumerated `signature_alg` values per spec §6.
pub const SIGNATURE_ALGS: &[&str] = &[
    "hmac-sha256",
    "ed25519+hmac-sha256",
    "sigstore+ed25519+hmac-sha256",
];

/// Enumerated `attestation_kind` values per spec §7.
pub const ATTESTATION_KINDS: &[&str] = &["pccs", "snp-report", "nitro-attestation", "nras"];

/// Structured error code mirroring `FormatErrorCode` in the Python SDK and
/// `kolm_format_error_t` in the C SDK.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormatErrorCode {
    MissingEntry,
    MissingField,
    BadType,
    BadHash,
    VersionMismatch,
    HashMismatch,
    SignatureMissing,
    SignatureInvalid,
    Internal,
}

impl FormatErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::MissingEntry => "missing_entry",
            Self::MissingField => "missing_field",
            Self::BadType => "bad_type",
            Self::BadHash => "bad_hash",
            Self::VersionMismatch => "version_mismatch",
            Self::HashMismatch => "hash_mismatch",
            Self::SignatureMissing => "signature_missing",
            Self::SignatureInvalid => "signature_invalid",
            Self::Internal => "internal",
        }
    }
}

/// Errors raised by the v1.0 format reader.
#[derive(Debug)]
pub struct FormatError {
    pub code: FormatErrorCode,
    pub message: String,
    pub field_name: Option<String>,
}

impl std::fmt::Display for FormatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.field_name {
            Some(field_name) => write!(f, "[{}] {} (field={})", self.code.as_str(), self.message, field_name),
            None => write!(f, "[{}] {}", self.code.as_str(), self.message),
        }
    }
}

impl std::error::Error for FormatError {}

impl FormatError {
    pub fn new(code: FormatErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), field_name: None }
    }

    pub fn with_field(code: FormatErrorCode, message: impl Into<String>, field_name: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            field_name: Some(field_name.into()),
        }
    }
}

impl From<serde_json::Error> for FormatError {
    fn from(e: serde_json::Error) -> Self {
        FormatError::new(FormatErrorCode::BadType, format!("json parse error: {e}"))
    }
}

/// `manifest.hashes` per spec §3.2. Required slots use [`EMPTY_SHA`] when
/// the payload is not bundled; optional slots are `None`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hashes {
    pub model_pointer: String,
    pub recipes_json: String,
    pub lora_bin: String,
    pub index_bin: String,
    pub evals_json: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_ir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attestation_report: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipe_bundle_mjs: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_weights: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra_files: Option<HashMap<String, String>>,
}

/// `manifest.policy` per spec §3.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Policy {
    pub require_ed25519: bool,
    pub require_rekor: bool,
}

/// `manifest.seed_provenance` per spec §3.1.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeedProvenance {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seeds_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub split_seed: Option<i64>,
    pub holdout_ratio: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub train_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holdout_hash: Option<String>,
    pub train_count: i64,
    pub holdout_count: i64,
    pub eval_source: String,
    pub comparator: String,
    pub production_ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leakage_report_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_seed_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approved_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub synthetic_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eval_provenance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_source_hashes: Option<Vec<String>>,
}

/// `manifest.binaries[]` entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinaryEntry {
    pub target: String,
    pub kind: String,
    pub recipe_id: String,
    pub filename: String,
    pub sha256: String,
    pub size: i64,
}

/// `manifest.confidential_compute` per spec §7.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttestationBlock {
    pub attestation_kind: String,
    pub attestation_report_hash: String,
    #[serde(default = "default_state")]
    pub state: String,
    #[serde(default)]
    pub verified: bool,
}

fn default_state() -> String {
    "shape_ok".to_string()
}

/// Reserved for W786 — only emitted on `format_version >= "1.1"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SustainabilityBadge {
    pub level: String,
    pub co2_grams_per_call: f64,
    pub watts_avg: f64,
    pub measured_at: String,
}

/// `manifest.k_score` per spec §3.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KScore {
    pub point: f64,
    pub ci95: [f64; 2],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calibration_pack_id: Option<String>,
}

/// Top-level manifest per spec §3.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub spec: String,
    pub format_version: String,
    pub job_id: String,
    pub task: String,
    pub created_at: String,
    pub runtime: String,
    pub runtime_target: String,
    pub artifact_class: String,
    pub base_model: String,
    pub tier: String,
    pub judge_id: String,
    pub eval_score: f64,
    pub recipes: Value,
    pub evals: Value,
    pub seed_provenance: SeedProvenance,
    pub hashes: Hashes,
    pub cid: String,
    pub policy: Policy,
    pub binaries: Vec<BinaryEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compiled_binary: Option<bool>,
    pub production_ready: bool,
    pub memory_requirement_mb: i64,
    pub offline_capable: bool,
    pub license: String,
    pub artifact_hash: String,

    // Optional / conditional blocks.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidential_compute: Option<AttestationBlock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sustainability_badge: Option<SustainabilityBadge>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub k_score: Option<KScore>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_cid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_schema_spec_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guardrails: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sparsity_profile: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kv_profile: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mixed_precision_profile: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry: Option<Value>,

    /// Forward-compat: unknown top-level fields are parked here so a
    /// downstream re-serializer can replay them. `#[serde(flatten)]`
    /// captures everything not enumerated above.
    #[serde(flatten)]
    pub raw_extras: HashMap<String, Value>,
}

/// Per-step entry in `receipt.chain`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainStep {
    pub step: String,
    pub input_hash: String,
    pub output_hash: String,
    pub hmac: String,
}

/// Per-file row in `receipt.artifact_files[]`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactFile {
    pub filename: String,
    pub sha256: String,
}

/// Build toolchain block per `receipt.build_toolchain`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildToolchain {
    pub node_version: String,
    pub platform: String,
    pub arch: String,
    pub kolm_version: String,
    pub runtime_target: String,
    pub signed_at: String,
}

/// Top-level receipt per spec §4.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Receipt {
    pub kolm_version: String,
    pub receipt_id: String,
    pub cid: String,
    pub artifact_hash: String,
    pub eval_set_hash: String,
    pub eval_score: f64,
    pub judge_id: String,
    pub tier: String,
    pub chain: Vec<ChainStep>,
    pub event_source_hashes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dataset_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub train_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holdout_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub split_seed: Option<i64>,
    pub runtime_target: String,
    pub artifact_files: Vec<ArtifactFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build_toolchain: Option<BuildToolchain>,
    pub signature_alg: String,
    pub signed_at: String,
    pub signed_by: String,
    pub signature: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature_ed25519: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature_sigstore: Option<Value>,
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

/// Parse a `manifest.json` buffer into a [`Manifest`].
pub fn parse_manifest(bytes: &[u8]) -> Result<Manifest, FormatError> {
    let m: Manifest = serde_json::from_slice(bytes)?;
    Ok(m)
}

/// Parse a `receipt.json` buffer into a [`Receipt`].
pub fn parse_receipt(bytes: &[u8]) -> Result<Receipt, FormatError> {
    let r: Receipt = serde_json::from_slice(bytes)?;
    Ok(r)
}

/// Validate a parsed manifest against the v1.0 schema.
pub fn validate_manifest(m: &Manifest) -> Result<(), FormatError> {
    if m.spec != KOLM_FORMAT_SPEC {
        return Err(FormatError::with_field(
            FormatErrorCode::VersionMismatch,
            format!("unsupported spec marker: {:?}", m.spec),
            "spec",
        ));
    }
    if !m.format_version.starts_with("1.") {
        return Err(FormatError::with_field(
            FormatErrorCode::VersionMismatch,
            format!("unsupported format_version: {:?}", m.format_version),
            "format_version",
        ));
    }
    if !ARTIFACT_CLASSES.contains(&m.artifact_class.as_str()) {
        return Err(FormatError::with_field(
            FormatErrorCode::BadType,
            format!("unknown artifact_class: {}", m.artifact_class),
            "artifact_class",
        ));
    }
    if !RUNTIME_TARGETS.contains(&m.runtime_target.as_str()) {
        return Err(FormatError::with_field(
            FormatErrorCode::BadType,
            format!("unknown runtime_target: {}", m.runtime_target),
            "runtime_target",
        ));
    }
    if m.runtime != m.runtime_target {
        return Err(FormatError::with_field(
            FormatErrorCode::BadType,
            format!("runtime ({}) must equal runtime_target ({})", m.runtime, m.runtime_target),
            "runtime",
        ));
    }
    if !TIERS.contains(&m.tier.as_str()) {
        return Err(FormatError::with_field(
            FormatErrorCode::BadType,
            format!("unknown tier: {}", m.tier),
            "tier",
        ));
    }
    if !(0.0..=1.0).contains(&m.eval_score) {
        return Err(FormatError::with_field(
            FormatErrorCode::BadType,
            format!("eval_score out of range: {}", m.eval_score),
            "eval_score",
        ));
    }
    if !is_sha256_hex(&m.cid) {
        return Err(FormatError::with_field(
            FormatErrorCode::BadHash,
            format!("cid is not a sha256 hex: {}", m.cid),
            "cid",
        ));
    }
    if !is_sha256_hex(&m.artifact_hash) {
        return Err(FormatError::with_field(
            FormatErrorCode::BadHash,
            format!("artifact_hash is not a sha256 hex: {}", m.artifact_hash),
            "artifact_hash",
        ));
    }
    if let Some(cc) = &m.confidential_compute {
        if !ATTESTATION_KINDS.contains(&cc.attestation_kind.as_str()) {
            return Err(FormatError::with_field(
                FormatErrorCode::BadType,
                format!("unknown attestation_kind: {}", cc.attestation_kind),
                "confidential_compute.attestation_kind",
            ));
        }
    }
    Ok(())
}

/// Read `manifest.json` from a `.kolm` ZIP and validate it.
///
/// The ZIP layer is intentionally not bundled. A working reader pairs
/// this function with the `zip` crate or equivalent; this entrypoint
/// expects the caller to have already verified the required-entries
/// invariant and read the manifest bytes. See
/// [`parse_manifest_from_zip`] for a sketch that requires the `zip`
/// crate.
pub fn validate_manifest_from_bytes(bytes: &[u8]) -> Result<Manifest, FormatError> {
    let m = parse_manifest(bytes)?;
    validate_manifest(&m)?;
    Ok(m)
}

/// Read the manifest from a `.kolm` ZIP on disk.
///
/// This is a sketch that documents the contract: it requires a ZIP
/// library to actually open the archive. The kolm crate's `Cargo.toml`
/// does NOT yet ship a ZIP dep (W817 keeps the dep footprint stable),
/// so this function returns `FormatError::Internal` with an actionable
/// install hint when called. Downstream consumers can drop in
/// `zip = "0.6"` and replace the body with the obvious 5-liner.
pub fn parse_manifest_from_zip(_zip_path: &Path) -> Result<Manifest, FormatError> {
    Err(FormatError::new(
        FormatErrorCode::Internal,
        "parse_manifest_from_zip requires a ZIP dep; \
         add `zip = \"0.6\"` to your Cargo.toml and replace this stub with `zip::ZipArchive::new(File::open(zip_path)?)`",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_sha_is_sha256_hex() {
        assert!(is_sha256_hex(EMPTY_SHA));
        assert!(!is_sha256_hex(""));
        assert!(!is_sha256_hex("nothex"));
    }

    #[test]
    fn validate_rejects_bad_spec() {
        let mut m = minimal_manifest();
        m.spec = "kolm-2".to_string();
        let err = validate_manifest(&m).unwrap_err();
        assert_eq!(err.code, FormatErrorCode::VersionMismatch);
    }

    fn minimal_manifest() -> Manifest {
        Manifest {
            spec: KOLM_FORMAT_SPEC.to_string(),
            format_version: KOLM_FORMAT_VERSION.to_string(),
            job_id: "00000000-0000-0000-0000-000000000001".to_string(),
            task: "demo.echo".to_string(),
            created_at: "2026-05-24T00:00:00.000Z".to_string(),
            runtime: "js".to_string(),
            runtime_target: "js".to_string(),
            artifact_class: "rule".to_string(),
            base_model: "Qwen/Qwen2.5-3B-Instruct".to_string(),
            tier: "recipe".to_string(),
            judge_id: "exact-match".to_string(),
            eval_score: 1.0,
            recipes: serde_json::json!({"n": 1, "registry_hash": EMPTY_SHA}),
            evals: serde_json::json!({"n": 1, "spec": "kolm-evals-1", "hash": EMPTY_SHA}),
            seed_provenance: SeedProvenance {
                seeds_hash: None,
                split_seed: None,
                holdout_ratio: 0.0,
                train_hash: None,
                holdout_hash: None,
                train_count: 0,
                holdout_count: 0,
                eval_source: "self_generated".to_string(),
                comparator: "exact".to_string(),
                production_ready: false,
                leakage_report_hash: None,
                group_key: None,
                source_seed_count: None,
                approved_count: None,
                synthetic_count: None,
                eval_provenance: None,
                event_source_hashes: None,
            },
            hashes: Hashes {
                model_pointer: EMPTY_SHA.to_string(),
                recipes_json: EMPTY_SHA.to_string(),
                lora_bin: EMPTY_SHA.to_string(),
                index_bin: EMPTY_SHA.to_string(),
                evals_json: EMPTY_SHA.to_string(),
                workflow_ir: None,
                attestation_report: None,
                recipe_bundle_mjs: None,
                model_weights: None,
                extra_files: None,
            },
            cid: EMPTY_SHA.to_string(),
            policy: Policy { require_ed25519: true, require_rekor: false },
            binaries: Vec::new(),
            compiled_binary: None,
            production_ready: false,
            memory_requirement_mb: 5,
            offline_capable: true,
            license: "Apache-2.0".to_string(),
            artifact_hash: EMPTY_SHA.to_string(),
            confidential_compute: None,
            sustainability_badge: None,
            k_score: None,
            parent_cid: None,
            region: None,
            output_schema: None,
            output_schema_spec_version: None,
            guardrails: None,
            sparsity_profile: None,
            kv_profile: None,
            mixed_precision_profile: None,
            entry: None,
            raw_extras: HashMap::new(),
        }
    }
}
