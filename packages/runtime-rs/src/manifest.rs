//! Manifest, receipt, and supporting type definitions for `.kolm` artifacts.
//!
//! These shapes mirror the JSON the Node toolchain writes in
//! `src/artifact.js`. Unknown fields are preserved via `#[serde(flatten)]`
//! catch-alls so future server-side additions don't break the parser.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// Manifest stored at `manifest.json` inside a `.kolm` zip.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    /// Artifact spec identifier (currently `kolm-1`).
    pub spec: String,
    /// Server-side job ID (`job_<hex>`).
    pub job_id: String,
    /// User-supplied task description.
    pub task: Option<Value>,
    /// ISO timestamp at which the artifact was packaged.
    pub created_at: String,
    /// Runtime hint (`cloud`, `on-device`, …).
    pub runtime: String,
    /// Base model pointer.
    pub base_model: String,
    /// Artifact tier (`recipe`, `adapter`, `specialist`, `bundle`).
    pub tier: String,
    /// Eval judge identifier.
    pub judge_id: String,
    /// Composite eval score on declared positives (0..1).
    pub eval_score: f64,
    /// Recipe registry summary.
    pub recipes: ManifestRecipes,
    /// LoRA pointer (or null in the recipe tier).
    pub lora: Option<Value>,
    /// Recall namespace pointer (or null).
    pub recall: Option<Value>,
    /// Training stats.
    pub training: Option<Value>,
    /// Eval set summary.
    pub evals: ManifestEvals,
    /// Embedded K-score envelope.
    pub k_score: Option<KScore>,
    /// Content-id of this artifact (`cidv1:sha256:<hex>`).
    pub cid: Option<String>,
    /// Per-file SHA-256 hashes used to derive the CID and artifact_hash.
    pub hashes: ManifestHashes,
    /// Forward-compatible catch-all for fields added in future versions.
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// Per-file SHA-256 hashes recorded inside the manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestHashes {
    /// SHA-256 of `model.gguf` bytes.
    pub model_pointer: String,
    /// SHA-256 of `recipes.json` bytes.
    pub recipes_json: String,
    /// SHA-256 of `lora.bin` bytes.
    pub lora_bin: String,
    /// SHA-256 of `index.sqlite-vec` bytes.
    pub index_bin: String,
    /// SHA-256 of `evals.json` bytes.
    pub evals_json: String,
}

/// Recipe registry summary embedded in the manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestRecipes {
    /// Number of recipes in `recipes.json`.
    pub n: u64,
    /// SHA-256 over `[{id, hash}]` for the recipe pack — quick integrity check.
    pub registry_hash: String,
}

/// Eval set summary embedded in the manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestEvals {
    /// Number of cases.
    pub n: u64,
    /// Eval spec identifier (e.g. `rs-1-evals`).
    pub spec: String,
    /// SHA-256 of `evals.json` bytes (mirror of `hashes.evals_json`).
    pub hash: String,
}

/// K-score envelope embedded in the manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KScore {
    /// Pass-rate on declared positives (A axis).
    pub accuracy: f64,
    /// Eval coverage (V axis).
    pub coverage: f64,
    /// p50 latency in microseconds.
    pub p50_latency_us: Option<f64>,
    /// $ per call at run time.
    pub cost_usd_per_call: f64,
    /// Zip size at probe time (S axis input).
    pub size_bytes: u64,
    /// Normalized size sub-score (0..1).
    #[serde(default)]
    pub size_score: f64,
    /// Normalized latency sub-score (0..1).
    #[serde(default)]
    pub latency_score: f64,
    /// Normalized cost sub-score (0..1).
    #[serde(default)]
    pub cost_score: f64,
    /// Composite score (0..1).
    pub composite: f64,
    /// Whether the artifact passes the ship gate.
    #[serde(default)]
    pub ships: bool,
    /// Ship gate threshold (`0.85` today).
    #[serde(default = "default_k_score_gate")]
    pub gate: f64,
    /// Spec identifier (`k-score-1` or `k-score-2`).
    pub spec: String,
    /// Forward-compatible catch-all for new axes (R/F/E/Z, etc.).
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

fn default_k_score_gate() -> f64 {
    0.85
}

/// Receipt stored at `receipt.json` inside a `.kolm` zip.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Receipt {
    /// Spec version (`0.1`).
    pub kolm_version: String,
    /// Receipt UUID.
    pub receipt_id: String,
    /// Content-id this receipt covers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cid: Option<String>,
    /// Hash of the artifact bytes this receipt covers.
    pub artifact_hash: String,
    /// Hash of the eval set bytes.
    pub eval_set_hash: String,
    /// Composite eval score (matches manifest.eval_score).
    pub eval_score: f64,
    /// Eval judge identifier.
    pub judge_id: String,
    /// Artifact tier.
    pub tier: String,
    /// 5-step HMAC chain (task → seeds → recipes → evals → package).
    pub chain: Vec<ReceiptChainStep>,
    /// External anchor references (e.g. transparency log entries).
    #[serde(default)]
    pub anchors: Vec<Value>,
    /// Signature algorithm — `hmac-sha256` today.
    pub signature_alg: String,
    /// Signing timestamp.
    pub signed_at: String,
    /// Key namespace (`kolm-dev-hmac-1` today).
    pub signed_by: String,
    /// HMAC over the receipt body (with `signature` field stripped).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    /// Forward-compatible catch-all.
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// One step of the 5-step receipt HMAC chain.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiptChainStep {
    /// Step name (`task`, `seeds`, `recipes`, `evals`, `package`).
    pub step: String,
    /// SHA-256 of the previous step's output (or the artifact spec for step 0).
    pub input_hash: String,
    /// SHA-256 of this step's output.
    pub output_hash: String,
    /// HMAC-SHA256 over canonical `{step, input_hash, output_hash}`.
    pub hmac: String,
}
