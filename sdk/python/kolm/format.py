"""kolm artifact format v1.0 reference reader (Python).

Pure-stdlib implementation of the .kolm artifact format v1.0 specified in
``docs/spec/kolm-format-v1.0.md``. No third-party deps: only ``json``,
``hashlib``, ``zipfile``, ``dataclasses``, ``pathlib``.

Honesty contract:
  * Every field name on the dataclasses below MUST match the JSON key
    used in manifest.json / receipt.json verbatim. The v1.0 spec
    enforces field-name parity across C / Python / Rust SDKs (see
    ``tests/wave817-format-v1.test.js`` for the parity gate).
  * Optional fields default to ``None``. Callers MUST distinguish
    ``None`` (absent) from an empty list / empty dict — the conditional-
    slot pattern in section 5 of the spec depends on it.
  * Hashes are stored as 64-char lowercase hex strings. ``EMPTY_SHA``
    (sha256 of zero bytes) is the explicit honest-empty marker.
  * ``FormatError`` carries a structured ``code`` matching the
    ``kolm_format_error_t`` enum in ``sdk/c/kolm-format.h``.

Round-trip rule (forward-compat): ``to_dict`` includes only fields the
caller populated; unknown fields parsed from raw JSON are preserved on
the ``raw_extras`` attribute so a downstream re-serializer can replay
them without modification.
"""
from __future__ import annotations

import hashlib
import json
import zipfile
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

__all__ = [
    "KOLM_FORMAT_SPEC",
    "KOLM_FORMAT_VERSION",
    "EMPTY_SHA",
    "FormatError",
    "FormatErrorCode",
    "Hashes",
    "Policy",
    "SeedProvenance",
    "BinaryEntry",
    "AttestationBlock",
    "SustainabilityBadge",
    "KScore",
    "Manifest",
    "ChainStep",
    "ArtifactFile",
    "BuildToolchain",
    "Receipt",
    "load_manifest_from_zip",
    "load_receipt_from_zip",
    "parse_manifest",
    "parse_receipt",
    "validate_manifest",
    "recompute_artifact_hash",
]

KOLM_FORMAT_SPEC = "kolm-1"
KOLM_FORMAT_VERSION = "1.0"
EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

# Mirrors kolm_format_error_t in sdk/c/kolm-format.h.
class FormatErrorCode:
    OK = "ok"
    MISSING_ENTRY = "missing_entry"
    MISSING_FIELD = "missing_field"
    BAD_TYPE = "bad_type"
    BAD_HASH = "bad_hash"
    VERSION_MISMATCH = "version_mismatch"
    HASH_MISMATCH = "hash_mismatch"
    SIGNATURE_MISSING = "signature_missing"
    SIGNATURE_INVALID = "signature_invalid"
    INTERNAL = "internal"


class FormatError(Exception):
    """Raised on any v1.0 conformance failure. Pairs with FormatErrorCode."""

    def __init__(self, code: str, message: str, field_name: Optional[str] = None):
        self.code = code
        self.field_name = field_name
        super().__init__(f"[{code}] {message}" + (f" (field={field_name})" if field_name else ""))


# Required six top-level ZIP entries per spec §2.
REQUIRED_ENTRIES = (
    "manifest.json",
    "recipes.json",
    "evals.json",
    "signature.sig",
    "receipt.json",
    "credential.json",
)

# Enumerated values per spec §3.
ARTIFACT_CLASSES = frozenset(["rule", "synthesized_rule", "compiled_rule", "distilled_model"])
RUNTIME_TARGETS = frozenset(["js", "gguf", "onnx", "wasm", "native"])
TIERS = frozenset(["recipe", "adapter", "specialist", "bundle"])
SIGNATURE_ALGS = frozenset(["hmac-sha256", "ed25519+hmac-sha256", "sigstore+ed25519+hmac-sha256"])
ATTESTATION_KINDS = frozenset(["pccs", "snp-report", "nitro-attestation", "nras"])


def _is_sha256_hex(value: Any) -> bool:
    if not isinstance(value, str) or len(value) != 64:
        return False
    try:
        int(value, 16)
        return True
    except ValueError:
        return False


def _require_sha256(value: Any, field_name: str) -> str:
    if not _is_sha256_hex(value):
        raise FormatError(FormatErrorCode.BAD_HASH, f"not a sha256 hex string: {value!r}", field_name)
    return value


def _require(d: Dict[str, Any], key: str, expected_type: Optional[type] = None) -> Any:
    if key not in d:
        raise FormatError(FormatErrorCode.MISSING_FIELD, f"required field missing: {key}", key)
    v = d[key]
    if expected_type is not None and not isinstance(v, expected_type):
        raise FormatError(FormatErrorCode.BAD_TYPE,
                          f"field {key} expected {expected_type.__name__}, got {type(v).__name__}", key)
    return v


@dataclass
class Hashes:
    """manifest.hashes per spec §3.2. Always-present slots use EMPTY_SHA when absent."""

    model_pointer: str = EMPTY_SHA
    recipes_json: str = EMPTY_SHA
    lora_bin: str = EMPTY_SHA
    index_bin: str = EMPTY_SHA
    evals_json: str = EMPTY_SHA
    # Conditional slots (None when payload not bundled).
    workflow_ir: Optional[str] = None
    attestation_report: Optional[str] = None
    recipe_bundle_mjs: Optional[str] = None
    model_weights: Optional[str] = None
    extra_files: Optional[Dict[str, str]] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Hashes":
        out = cls(
            model_pointer=_require_sha256(d.get("model_pointer", EMPTY_SHA), "hashes.model_pointer"),
            recipes_json=_require_sha256(d.get("recipes_json", EMPTY_SHA), "hashes.recipes_json"),
            lora_bin=_require_sha256(d.get("lora_bin", EMPTY_SHA), "hashes.lora_bin"),
            index_bin=_require_sha256(d.get("index_bin", EMPTY_SHA), "hashes.index_bin"),
            evals_json=_require_sha256(d.get("evals_json", EMPTY_SHA), "hashes.evals_json"),
        )
        for key in ("workflow_ir", "attestation_report", "recipe_bundle_mjs", "model_weights"):
            if key in d:
                setattr(out, key, _require_sha256(d[key], f"hashes.{key}"))
        if "extra_files" in d and isinstance(d["extra_files"], dict):
            out.extra_files = {
                str(k): _require_sha256(v, f"hashes.extra_files.{k}") for k, v in d["extra_files"].items()
            }
        return out

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "model_pointer": self.model_pointer,
            "recipes_json": self.recipes_json,
            "lora_bin": self.lora_bin,
            "index_bin": self.index_bin,
            "evals_json": self.evals_json,
        }
        for key in ("workflow_ir", "attestation_report", "recipe_bundle_mjs", "model_weights"):
            v = getattr(self, key)
            if v is not None:
                out[key] = v
        if self.extra_files is not None:
            out["extra_files"] = dict(self.extra_files)
        return out


@dataclass
class Policy:
    """manifest.policy per spec §3."""

    require_ed25519: bool = True
    require_rekor: bool = False

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Policy":
        return cls(
            require_ed25519=bool(d.get("require_ed25519", True)),
            require_rekor=bool(d.get("require_rekor", False)),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {"require_ed25519": self.require_ed25519, "require_rekor": self.require_rekor}


@dataclass
class SeedProvenance:
    """manifest.seed_provenance per spec §3.1."""

    seeds_hash: Optional[str] = None
    split_seed: Optional[int] = None
    holdout_ratio: float = 0.0
    train_hash: Optional[str] = None
    holdout_hash: Optional[str] = None
    train_count: int = 0
    holdout_count: int = 0
    eval_source: str = "unknown"
    comparator: str = "exact"
    production_ready: bool = False
    leakage_report_hash: Optional[str] = None
    group_key: Optional[str] = None
    source_seed_count: Optional[int] = None
    approved_count: Optional[int] = None
    synthetic_count: Optional[int] = None
    eval_provenance: Optional[str] = None
    event_source_hashes: Optional[List[str]] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "SeedProvenance":
        out = cls(
            seeds_hash=d.get("seeds_hash"),
            split_seed=d.get("split_seed"),
            holdout_ratio=float(d.get("holdout_ratio", 0.0)),
            train_hash=d.get("train_hash"),
            holdout_hash=d.get("holdout_hash"),
            train_count=int(d.get("train_count", 0)),
            holdout_count=int(d.get("holdout_count", 0)),
            eval_source=str(d.get("eval_source", "unknown")),
            comparator=str(d.get("comparator", "exact")),
            production_ready=bool(d.get("production_ready", False)),
            leakage_report_hash=d.get("leakage_report_hash"),
            group_key=d.get("group_key"),
            source_seed_count=d.get("source_seed_count"),
            approved_count=d.get("approved_count"),
            synthetic_count=d.get("synthetic_count"),
            eval_provenance=d.get("eval_provenance"),
            event_source_hashes=d.get("event_source_hashes"),
        )
        return out

    def to_dict(self) -> Dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v is not None or k in (
            "holdout_ratio", "train_count", "holdout_count", "eval_source",
            "comparator", "production_ready",
        )}


@dataclass
class BinaryEntry:
    """manifest.binaries[] entry."""

    target: str
    kind: str
    recipe_id: str
    filename: str
    sha256: str
    size: int

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "BinaryEntry":
        return cls(
            target=str(_require(d, "target", str)),
            kind=str(_require(d, "kind", str)),
            recipe_id=str(_require(d, "recipe_id", str)),
            filename=str(_require(d, "filename", str)),
            sha256=_require_sha256(_require(d, "sha256"), "binaries[].sha256"),
            size=int(_require(d, "size", int)),
        )

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class AttestationBlock:
    """manifest.confidential_compute per spec §7."""

    attestation_kind: str
    attestation_report_hash: str
    state: str = "shape_ok"
    verified: bool = False

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AttestationBlock":
        kind = str(_require(d, "attestation_kind", str))
        if kind not in ATTESTATION_KINDS:
            raise FormatError(FormatErrorCode.BAD_TYPE,
                              f"unknown attestation_kind: {kind}", "confidential_compute.attestation_kind")
        return cls(
            attestation_kind=kind,
            attestation_report_hash=_require_sha256(_require(d, "attestation_report_hash"),
                                                   "confidential_compute.attestation_report_hash"),
            state=str(d.get("state", "shape_ok")),
            verified=bool(d.get("verified", False)),
        )

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class SustainabilityBadge:
    """Reserved for W786 — only emitted on format_version >= 1.1."""

    level: str
    co2_grams_per_call: float
    watts_avg: float
    measured_at: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "SustainabilityBadge":
        return cls(
            level=str(_require(d, "level", str)),
            co2_grams_per_call=float(_require(d, "co2_grams_per_call")),
            watts_avg=float(_require(d, "watts_avg")),
            measured_at=str(_require(d, "measured_at", str)),
        )

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class KScore:
    """manifest.k_score per spec §3."""

    point: float
    ci95: List[float]
    calibration_pack_id: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "KScore":
        ci = d.get("ci95")
        if not isinstance(ci, list) or len(ci) != 2:
            raise FormatError(FormatErrorCode.BAD_TYPE, "k_score.ci95 must be a [low, high] pair", "k_score.ci95")
        return cls(
            point=float(_require(d, "point")),
            ci95=[float(ci[0]), float(ci[1])],
            calibration_pack_id=d.get("calibration_pack_id"),
        )

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class Manifest:
    """Top-level manifest per spec §3."""

    spec: str = KOLM_FORMAT_SPEC
    format_version: str = KOLM_FORMAT_VERSION
    job_id: str = ""
    task: str = ""
    created_at: str = ""
    runtime: str = "js"
    runtime_target: str = "js"
    artifact_class: str = "rule"
    base_model: str = ""
    tier: str = "recipe"
    judge_id: str = ""
    eval_score: float = 0.0
    recipes: Dict[str, Any] = field(default_factory=dict)
    evals: Dict[str, Any] = field(default_factory=dict)
    seed_provenance: SeedProvenance = field(default_factory=SeedProvenance)
    hashes: Hashes = field(default_factory=Hashes)
    cid: str = ""
    policy: Policy = field(default_factory=Policy)
    binaries: List[BinaryEntry] = field(default_factory=list)
    compiled_binary: Optional[bool] = None
    production_ready: bool = False
    memory_requirement_mb: int = 5
    offline_capable: bool = True
    license: str = ""
    artifact_hash: str = ""

    # Optional / conditional blocks.
    confidential_compute: Optional[AttestationBlock] = None
    sustainability_badge: Optional[SustainabilityBadge] = None
    k_score: Optional[KScore] = None
    parent_cid: Optional[str] = None
    region: Optional[str] = None
    output_schema: Optional[Any] = None
    output_schema_spec_version: Optional[str] = None
    guardrails: Optional[List[Any]] = None
    sparsity_profile: Optional[Any] = None
    kv_profile: Optional[Any] = None
    mixed_precision_profile: Optional[List[Any]] = None
    entry: Optional[Dict[str, Any]] = None

    # Forward-compat bucket: every field NOT explicitly listed above is
    # parked here so to_dict round-trips unknown fields verbatim.
    raw_extras: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Manifest":
        known = {
            "spec", "format_version", "job_id", "task", "created_at",
            "runtime", "runtime_target", "artifact_class", "base_model",
            "tier", "judge_id", "eval_score", "recipes", "evals",
            "seed_provenance", "hashes", "cid", "policy", "binaries",
            "compiled_binary", "production_ready", "memory_requirement_mb",
            "offline_capable", "license", "artifact_hash",
            "confidential_compute", "sustainability_badge", "k_score",
            "parent_cid", "region", "output_schema", "output_schema_spec_version",
            "guardrails", "sparsity_profile", "kv_profile",
            "mixed_precision_profile", "entry",
        }
        m = cls(
            spec=str(d.get("spec", KOLM_FORMAT_SPEC)),
            format_version=str(d.get("format_version", KOLM_FORMAT_VERSION)),
            job_id=str(_require(d, "job_id")),
            task=str(_require(d, "task")),
            created_at=str(_require(d, "created_at")),
            runtime=str(_require(d, "runtime")),
            runtime_target=str(_require(d, "runtime_target")),
            artifact_class=str(_require(d, "artifact_class")),
            base_model=str(_require(d, "base_model")),
            tier=str(_require(d, "tier")),
            judge_id=str(_require(d, "judge_id")),
            eval_score=float(_require(d, "eval_score")),
            recipes=dict(_require(d, "recipes", dict)),
            evals=dict(_require(d, "evals", dict)),
            seed_provenance=SeedProvenance.from_dict(_require(d, "seed_provenance", dict)),
            hashes=Hashes.from_dict(_require(d, "hashes", dict)),
            cid=_require_sha256(_require(d, "cid"), "cid"),
            policy=Policy.from_dict(_require(d, "policy", dict)),
            binaries=[BinaryEntry.from_dict(b) for b in d.get("binaries", [])],
            compiled_binary=d.get("compiled_binary"),
            production_ready=bool(_require(d, "production_ready")),
            memory_requirement_mb=int(d.get("memory_requirement_mb", 5)),
            offline_capable=bool(d.get("offline_capable", True)),
            license=str(d.get("license", "")),
            artifact_hash=_require_sha256(_require(d, "artifact_hash"), "artifact_hash"),
        )
        if "confidential_compute" in d:
            m.confidential_compute = AttestationBlock.from_dict(d["confidential_compute"])
        if "sustainability_badge" in d:
            m.sustainability_badge = SustainabilityBadge.from_dict(d["sustainability_badge"])
        if "k_score" in d:
            m.k_score = KScore.from_dict(d["k_score"])
        for key in ("parent_cid", "region", "output_schema", "output_schema_spec_version",
                    "guardrails", "sparsity_profile", "kv_profile",
                    "mixed_precision_profile", "entry"):
            if key in d:
                setattr(m, key, d[key])
        # Preserve unknown fields verbatim.
        for key, value in d.items():
            if key not in known:
                m.raw_extras[key] = value
        return m

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "spec": self.spec,
            "format_version": self.format_version,
            "job_id": self.job_id,
            "task": self.task,
            "created_at": self.created_at,
            "runtime": self.runtime,
            "runtime_target": self.runtime_target,
            "artifact_class": self.artifact_class,
            "base_model": self.base_model,
            "tier": self.tier,
            "judge_id": self.judge_id,
            "eval_score": self.eval_score,
            "recipes": dict(self.recipes),
            "evals": dict(self.evals),
            "seed_provenance": self.seed_provenance.to_dict(),
            "hashes": self.hashes.to_dict(),
            "cid": self.cid,
            "policy": self.policy.to_dict(),
            "binaries": [b.to_dict() for b in self.binaries],
            "compiled_binary": self.compiled_binary,
            "production_ready": self.production_ready,
            "memory_requirement_mb": self.memory_requirement_mb,
            "offline_capable": self.offline_capable,
            "license": self.license,
            "artifact_hash": self.artifact_hash,
        }
        if self.confidential_compute is not None:
            out["confidential_compute"] = self.confidential_compute.to_dict()
        if self.sustainability_badge is not None:
            out["sustainability_badge"] = self.sustainability_badge.to_dict()
        if self.k_score is not None:
            out["k_score"] = self.k_score.to_dict()
        for key in ("parent_cid", "region", "output_schema", "output_schema_spec_version",
                    "guardrails", "sparsity_profile", "kv_profile",
                    "mixed_precision_profile", "entry"):
            v = getattr(self, key)
            if v is not None:
                out[key] = v
        for key, value in self.raw_extras.items():
            out.setdefault(key, value)
        return out


@dataclass
class ChainStep:
    step: str
    input_hash: str
    output_hash: str
    hmac: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ChainStep":
        return cls(
            step=str(_require(d, "step", str)),
            input_hash=_require_sha256(_require(d, "input_hash"), "chain[].input_hash"),
            output_hash=_require_sha256(_require(d, "output_hash"), "chain[].output_hash"),
            hmac=_require_sha256(_require(d, "hmac"), "chain[].hmac"),
        )

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class ArtifactFile:
    filename: str
    sha256: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ArtifactFile":
        return cls(
            filename=str(_require(d, "filename", str)),
            sha256=_require_sha256(_require(d, "sha256"), "artifact_files[].sha256"),
        )

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class BuildToolchain:
    node_version: str
    platform: str
    arch: str
    kolm_version: str
    runtime_target: str
    signed_at: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "BuildToolchain":
        return cls(
            node_version=str(_require(d, "node_version", str)),
            platform=str(_require(d, "platform", str)),
            arch=str(_require(d, "arch", str)),
            kolm_version=str(_require(d, "kolm_version", str)),
            runtime_target=str(_require(d, "runtime_target", str)),
            signed_at=str(_require(d, "signed_at", str)),
        )

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class Receipt:
    kolm_version: str = "0.1"
    receipt_id: str = ""
    cid: str = ""
    artifact_hash: str = ""
    eval_set_hash: str = ""
    eval_score: float = 0.0
    judge_id: str = ""
    tier: str = "recipe"
    chain: List[ChainStep] = field(default_factory=list)
    event_source_hashes: List[str] = field(default_factory=list)
    dataset_hash: Optional[str] = None
    train_hash: Optional[str] = None
    holdout_hash: Optional[str] = None
    split_seed: Optional[int] = None
    runtime_target: str = "js"
    artifact_files: List[ArtifactFile] = field(default_factory=list)
    build_toolchain: Optional[BuildToolchain] = None
    signature_alg: str = "hmac-sha256"
    signed_at: str = ""
    signed_by: str = ""
    signature: str = ""
    signature_ed25519: Optional[Dict[str, Any]] = None
    signature_sigstore: Optional[Dict[str, Any]] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Receipt":
        r = cls(
            kolm_version=str(_require(d, "kolm_version", str)),
            receipt_id=str(_require(d, "receipt_id", str)),
            cid=_require_sha256(_require(d, "cid"), "cid"),
            artifact_hash=_require_sha256(_require(d, "artifact_hash"), "artifact_hash"),
            eval_set_hash=_require_sha256(_require(d, "eval_set_hash"), "eval_set_hash"),
            eval_score=float(_require(d, "eval_score")),
            judge_id=str(_require(d, "judge_id", str)),
            tier=str(_require(d, "tier", str)),
            chain=[ChainStep.from_dict(c) for c in _require(d, "chain", list)],
            event_source_hashes=list(d.get("event_source_hashes", [])),
            dataset_hash=d.get("dataset_hash"),
            train_hash=d.get("train_hash"),
            holdout_hash=d.get("holdout_hash"),
            split_seed=d.get("split_seed"),
            runtime_target=str(_require(d, "runtime_target", str)),
            artifact_files=[ArtifactFile.from_dict(f) for f in d.get("artifact_files", [])],
            build_toolchain=BuildToolchain.from_dict(d["build_toolchain"]) if "build_toolchain" in d else None,
            signature_alg=str(_require(d, "signature_alg", str)),
            signed_at=str(_require(d, "signed_at", str)),
            signed_by=str(_require(d, "signed_by", str)),
            signature=str(_require(d, "signature", str)),
            signature_ed25519=d.get("signature_ed25519"),
            signature_sigstore=d.get("signature_sigstore"),
        )
        if r.signature_alg not in SIGNATURE_ALGS:
            raise FormatError(FormatErrorCode.VERSION_MISMATCH,
                              f"unknown signature_alg: {r.signature_alg}", "signature_alg")
        return r

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "kolm_version": self.kolm_version,
            "receipt_id": self.receipt_id,
            "cid": self.cid,
            "artifact_hash": self.artifact_hash,
            "eval_set_hash": self.eval_set_hash,
            "eval_score": self.eval_score,
            "judge_id": self.judge_id,
            "tier": self.tier,
            "chain": [c.to_dict() for c in self.chain],
            "event_source_hashes": list(self.event_source_hashes),
            "dataset_hash": self.dataset_hash,
            "train_hash": self.train_hash,
            "holdout_hash": self.holdout_hash,
            "split_seed": self.split_seed,
            "runtime_target": self.runtime_target,
            "artifact_files": [f.to_dict() for f in self.artifact_files],
            "signature_alg": self.signature_alg,
            "signed_at": self.signed_at,
            "signed_by": self.signed_by,
            "signature": self.signature,
        }
        if self.build_toolchain is not None:
            out["build_toolchain"] = self.build_toolchain.to_dict()
        if self.signature_ed25519 is not None:
            out["signature_ed25519"] = self.signature_ed25519
        if self.signature_sigstore is not None:
            out["signature_sigstore"] = self.signature_sigstore
        return out


def parse_manifest(json_bytes: Union[bytes, str]) -> Manifest:
    """Parse a manifest.json buffer into a Manifest. Raises FormatError on failure."""
    text = json_bytes.decode("utf-8") if isinstance(json_bytes, (bytes, bytearray)) else str(json_bytes)
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise FormatError(FormatErrorCode.BAD_TYPE, f"manifest.json not valid JSON: {e}") from e
    if not isinstance(data, dict):
        raise FormatError(FormatErrorCode.BAD_TYPE, "manifest.json must be an object")
    return Manifest.from_dict(data)


def parse_receipt(json_bytes: Union[bytes, str]) -> Receipt:
    """Parse a receipt.json buffer into a Receipt. Raises FormatError on failure."""
    text = json_bytes.decode("utf-8") if isinstance(json_bytes, (bytes, bytearray)) else str(json_bytes)
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise FormatError(FormatErrorCode.BAD_TYPE, f"receipt.json not valid JSON: {e}") from e
    if not isinstance(data, dict):
        raise FormatError(FormatErrorCode.BAD_TYPE, "receipt.json must be an object")
    return Receipt.from_dict(data)


def validate_manifest(m: Manifest) -> None:
    """Validate a parsed manifest against the v1.0 schema.

    Raises FormatError on the first failure. Performs:
      - spec == "kolm-1"
      - format_version starts with "1."
      - enum validation for artifact_class, runtime_target, tier
      - runtime == runtime_target (W457 lock)
      - eval_score in [0, 1]
      - policy / signature consistency is a runtime concern (validated
        against the receipt; not enforced here)
    """
    if m.spec != KOLM_FORMAT_SPEC:
        raise FormatError(FormatErrorCode.VERSION_MISMATCH,
                          f"unsupported spec marker: {m.spec!r}", "spec")
    if not m.format_version.startswith("1."):
        raise FormatError(FormatErrorCode.VERSION_MISMATCH,
                          f"unsupported format_version: {m.format_version!r}", "format_version")
    if m.artifact_class not in ARTIFACT_CLASSES:
        raise FormatError(FormatErrorCode.BAD_TYPE,
                          f"unknown artifact_class: {m.artifact_class}", "artifact_class")
    if m.runtime_target not in RUNTIME_TARGETS:
        raise FormatError(FormatErrorCode.BAD_TYPE,
                          f"unknown runtime_target: {m.runtime_target}", "runtime_target")
    if m.runtime != m.runtime_target:
        raise FormatError(FormatErrorCode.BAD_TYPE,
                          f"runtime ({m.runtime}) must equal runtime_target ({m.runtime_target})",
                          "runtime")
    if m.tier not in TIERS:
        raise FormatError(FormatErrorCode.BAD_TYPE, f"unknown tier: {m.tier}", "tier")
    if not (0.0 <= m.eval_score <= 1.0):
        raise FormatError(FormatErrorCode.BAD_TYPE,
                          f"eval_score out of range: {m.eval_score}", "eval_score")
    if m.confidential_compute is not None:
        if m.confidential_compute.attestation_kind not in ATTESTATION_KINDS:
            raise FormatError(FormatErrorCode.BAD_TYPE,
                              f"unknown attestation_kind: {m.confidential_compute.attestation_kind}",
                              "confidential_compute.attestation_kind")


def _canonical_json(value: Any) -> bytes:
    """Canonical JSON: sorted keys, no whitespace, UTF-8."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def recompute_artifact_hash(m: Manifest) -> str:
    """Recompute artifact_hash per spec §5 from a parsed manifest.

    Only the slots the spec enumerates contribute. The conditional-slot
    pattern (W460) MUST be honored: optional slots are keyed only when
    the corresponding payload or block is present.
    """
    manifest_dict = m.to_dict()
    manifest_dict.pop("artifact_hash", None)
    manifest_json = json.dumps(manifest_dict, indent=2)
    manifest_hash = hashlib.sha256(manifest_json.encode("utf-8")).hexdigest()
    inputs: Dict[str, Any] = {
        "manifest_hash": manifest_hash,
        "model_pointer_hash": m.hashes.model_pointer,
        "recipes_json_hash": m.hashes.recipes_json,
        "lora_bin_hash": m.hashes.lora_bin,
        "index_bin_hash": m.hashes.index_bin,
        "evals_json_hash": m.hashes.evals_json,
    }
    if m.hashes.workflow_ir:
        inputs["workflow_ir_hash"] = m.hashes.workflow_ir
    if m.hashes.attestation_report:
        inputs["attestation_report_hash"] = m.hashes.attestation_report
    if m.hashes.recipe_bundle_mjs:
        inputs["recipe_bundle_mjs_hash"] = m.hashes.recipe_bundle_mjs
    if m.hashes.model_weights:
        inputs["model_weights_hash"] = m.hashes.model_weights
    if m.hashes.extra_files:
        inputs["extra_files_hash"] = hashlib.sha256(_canonical_json(m.hashes.extra_files)).hexdigest()
    if m.confidential_compute is not None:
        inputs["confidential_compute_hash"] = hashlib.sha256(
            _canonical_json(m.confidential_compute.to_dict())
        ).hexdigest()
    if m.parent_cid:
        inputs["parent_cid"] = m.parent_cid
    if m.region:
        inputs["region_hash"] = hashlib.sha256(m.region.encode("utf-8")).hexdigest()
    if m.output_schema is not None:
        inputs["output_schema_hash"] = hashlib.sha256(_canonical_json(m.output_schema)).hexdigest()
    if m.guardrails:
        inputs["guardrails_hash"] = hashlib.sha256(_canonical_json(m.guardrails)).hexdigest()
    if m.sparsity_profile:
        inputs["sparsity_profile_hash"] = hashlib.sha256(_canonical_json(m.sparsity_profile)).hexdigest()
    if m.kv_profile:
        inputs["kv_profile_hash"] = hashlib.sha256(_canonical_json(m.kv_profile)).hexdigest()
    if m.mixed_precision_profile:
        inputs["mixed_precision_profile_hash"] = hashlib.sha256(
            _canonical_json(m.mixed_precision_profile)
        ).hexdigest()
    return hashlib.sha256(_canonical_json(inputs)).hexdigest()


def load_manifest_from_zip(zip_path: Union[str, Path]) -> Manifest:
    """Read manifest.json from a .kolm ZIP, parse, and validate it.

    Raises FormatError when the ZIP is missing required entries or when
    the manifest fails v1.0 conformance.
    """
    path = Path(zip_path)
    with zipfile.ZipFile(path, "r") as zf:
        names = set(zf.namelist())
        for entry in REQUIRED_ENTRIES:
            if entry not in names:
                raise FormatError(FormatErrorCode.MISSING_ENTRY,
                                  f"required ZIP entry missing: {entry}", entry)
        manifest_bytes = zf.read("manifest.json")
    m = parse_manifest(manifest_bytes)
    validate_manifest(m)
    return m


def load_receipt_from_zip(zip_path: Union[str, Path]) -> Receipt:
    """Read receipt.json from a .kolm ZIP and parse it."""
    path = Path(zip_path)
    with zipfile.ZipFile(path, "r") as zf:
        names = set(zf.namelist())
        for entry in REQUIRED_ENTRIES:
            if entry not in names:
                raise FormatError(FormatErrorCode.MISSING_ENTRY,
                                  f"required ZIP entry missing: {entry}", entry)
        receipt_bytes = zf.read("receipt.json")
    return parse_receipt(receipt_bytes)
