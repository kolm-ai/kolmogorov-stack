/*
 * sdk/c/kolm-format.h — kolm artifact format v1.0 reference reader (header).
 *
 * This is a header-only schema declaration for the .kolm artifact format
 * v1.0 as specified in docs/spec/kolm-format-v1.0.md. It defines structs
 * mirroring the JSON manifest + receipt schema, plus parse-function
 * prototypes for a v1.0 conformant reader.
 *
 * No implementation is bundled here on purpose. The format is JSON-over-
 * ZIP; a working reader pairs this header with:
 *   - a ZIP library (e.g. zlib + miniz, or libarchive)
 *   - a JSON parser (e.g. cJSON, jansson, json-c)
 *   - a sha256 implementation (e.g. OpenSSL, libsodium, public-domain
 *     sha256.c)
 *
 * Build (POSIX):
 *   cc -c your_reader.c -lz -lcrypto
 *
 * Honesty contract:
 *   - Every field name in the structs below MUST match the JSON key
 *     used in manifest.json / receipt.json verbatim. The v1.0 spec
 *     enforces field-name parity across C / Python / Rust SDKs (see
 *     tests/wave817-format-v1.test.js for the parity gate).
 *   - Optional fields are represented as nullable pointers. A NULL
 *     pointer means the field was absent from the source JSON. Callers
 *     MUST distinguish absent (NULL) from empty (non-NULL, empty
 *     string / zero-length array) — the conditional-slot pattern in
 *     section 5 of the spec depends on it.
 *   - Hashes are stored as 64-char hex strings with a trailing NUL
 *     terminator. EMPTY_SHA (zero-byte sha256) is the explicit honest-
 *     empty marker and is the literal constant
 *     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".
 */

#ifndef KOLM_FORMAT_H
#define KOLM_FORMAT_H

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Spec marker every v1.0 manifest declares as the value of "spec". */
#define KOLM_FORMAT_SPEC "kolm-1"

/** Default declared format_version for v1.0 manifests. */
#define KOLM_FORMAT_VERSION "1.0"

/** sha256 of zero bytes — the honest-empty marker for absent payloads. */
#define KOLM_EMPTY_SHA \
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

/** Length of a sha256 hex string (without trailing NUL). */
#define KOLM_SHA256_HEX_LEN 64

/** Length of a sha256 hex string including the trailing NUL terminator. */
#define KOLM_SHA256_BUF_LEN (KOLM_SHA256_HEX_LEN + 1)

/** Enumerated artifact_class values per docs/spec/kolm-format-v1.0.md §3. */
typedef enum {
  KOLM_CLASS_UNKNOWN = 0,
  KOLM_CLASS_RULE = 1,
  KOLM_CLASS_SYNTHESIZED_RULE = 2,
  KOLM_CLASS_COMPILED_RULE = 3,
  KOLM_CLASS_DISTILLED_MODEL = 4,
} kolm_artifact_class_t;

/** Enumerated runtime_target values per spec §3. */
typedef enum {
  KOLM_RUNTIME_UNKNOWN = 0,
  KOLM_RUNTIME_JS = 1,
  KOLM_RUNTIME_GGUF = 2,
  KOLM_RUNTIME_ONNX = 3,
  KOLM_RUNTIME_WASM = 4,
  KOLM_RUNTIME_NATIVE = 5,
} kolm_runtime_target_t;

/** Enumerated tier values per spec §3. */
typedef enum {
  KOLM_TIER_UNKNOWN = 0,
  KOLM_TIER_RECIPE = 1,
  KOLM_TIER_ADAPTER = 2,
  KOLM_TIER_SPECIALIST = 3,
  KOLM_TIER_BUNDLE = 4,
} kolm_tier_t;

/** Enumerated signature_alg values per spec §6. */
typedef enum {
  KOLM_SIG_ALG_UNKNOWN = 0,
  KOLM_SIG_ALG_HMAC_SHA256 = 1,
  KOLM_SIG_ALG_ED25519_HMAC = 2,
  KOLM_SIG_ALG_SIGSTORE_ED25519_HMAC = 3,
} kolm_signature_alg_t;

/** Confidential-compute attestation kinds per spec §7. */
typedef enum {
  KOLM_ATTESTATION_NONE = 0,
  KOLM_ATTESTATION_PCCS = 1,
  KOLM_ATTESTATION_SNP_REPORT = 2,
  KOLM_ATTESTATION_NITRO = 3,
  KOLM_ATTESTATION_NRAS = 4,
} kolm_attestation_kind_t;

/** Format-error codes surfaced by the parse helpers. */
typedef enum {
  KOLM_FORMAT_OK = 0,
  KOLM_FORMAT_ERR_MISSING_ENTRY = 1,        /**< required ZIP entry absent */
  KOLM_FORMAT_ERR_MISSING_FIELD = 2,        /**< required manifest field absent */
  KOLM_FORMAT_ERR_BAD_TYPE = 3,             /**< field has wrong JSON type */
  KOLM_FORMAT_ERR_BAD_HASH = 4,             /**< sha256 hex malformed */
  KOLM_FORMAT_ERR_VERSION_MISMATCH = 5,     /**< spec or format_version unsupported */
  KOLM_FORMAT_ERR_HASH_MISMATCH = 6,        /**< recomputed artifact_hash differs */
  KOLM_FORMAT_ERR_SIGNATURE_MISSING = 7,    /**< policy requires sig, none present */
  KOLM_FORMAT_ERR_SIGNATURE_INVALID = 8,    /**< signature verification failed */
  KOLM_FORMAT_ERR_OUT_OF_MEMORY = 9,
  KOLM_FORMAT_ERR_INTERNAL = 99,
} kolm_format_error_t;

/** Per-file hash map entry, used by hashes.extra_files and similar. */
typedef struct kolm_file_hash_s {
  char *filename;                  /**< owned UTF-8 string */
  char sha256[KOLM_SHA256_BUF_LEN];/**< lowercase hex, NUL-terminated */
} kolm_file_hash_t;

/** manifest.hashes per spec §3.2. */
typedef struct kolm_hashes_s {
  char model_pointer[KOLM_SHA256_BUF_LEN];
  char recipes_json[KOLM_SHA256_BUF_LEN];
  char lora_bin[KOLM_SHA256_BUF_LEN];
  char index_bin[KOLM_SHA256_BUF_LEN];
  char evals_json[KOLM_SHA256_BUF_LEN];
  /* Optional / conditional hash slots — NULL when absent. */
  char *workflow_ir;               /**< present when workflow_ir.json bundled */
  char *attestation_report;        /**< present when attestation_report.json bundled */
  char *recipe_bundle_mjs;         /**< present when recipe.bundle.mjs bundled */
  char *model_weights;             /**< present when weight blob bundled */
  /* Sorted array of extra-file hashes; NULL when none bundled. */
  kolm_file_hash_t *extra_files;
  size_t extra_files_len;
} kolm_hashes_t;

/** manifest.policy per spec §3. */
typedef struct kolm_policy_s {
  bool require_ed25519;
  bool require_rekor;
} kolm_policy_t;

/** manifest.seed_provenance per spec §3.1. */
typedef struct kolm_seed_provenance_s {
  char seeds_hash[KOLM_SHA256_BUF_LEN];
  int64_t split_seed;
  double holdout_ratio;
  char train_hash[KOLM_SHA256_BUF_LEN];
  char holdout_hash[KOLM_SHA256_BUF_LEN];
  int64_t train_count;
  int64_t holdout_count;
  char *eval_source;               /**< owned UTF-8; e.g. "real_eval" */
  char *comparator;                /**< owned UTF-8; e.g. "exact" */
  bool production_ready;
  /* Optional sub-fields, NULL/-1 when absent. */
  char *leakage_report_hash;
  char *group_key;
  int64_t source_seed_count;       /**< -1 when absent */
  int64_t approved_count;          /**< -1 when absent */
  int64_t synthetic_count;         /**< -1 when absent */
  char *eval_provenance;           /**< owned UTF-8 or NULL */
} kolm_seed_provenance_t;

/** manifest.binaries[] entry. */
typedef struct kolm_binary_entry_s {
  char *target;                    /**< owned UTF-8: "native" | "wasm" */
  char *kind;                      /**< owned UTF-8: "c" | "rust" */
  char *recipe_id;                 /**< owned UTF-8 */
  char *filename;                  /**< owned UTF-8 */
  char sha256[KOLM_SHA256_BUF_LEN];
  int64_t size;
} kolm_binary_entry_t;

/** manifest.confidential_compute per spec §7. */
typedef struct kolm_attestation_block_s {
  kolm_attestation_kind_t attestation_kind;
  char attestation_report_hash[KOLM_SHA256_BUF_LEN];
  /* state ∈ "shape_ok" | "verified" | "rejected" */
  char *state;
  bool verified;
} kolm_attestation_block_t;

/** Reserved for W786 — present only when format_version >= "1.1". */
typedef struct kolm_sustainability_badge_s {
  char *level;                     /**< e.g. "bronze" | "silver" | "gold" */
  double co2_grams_per_call;
  double watts_avg;
  char *measured_at;               /**< ISO-8601 */
} kolm_sustainability_badge_t;

/** manifest.k_score per spec §3. */
typedef struct kolm_k_score_s {
  double point;
  double ci95_low;
  double ci95_high;
  char *calibration_pack_id;       /**< owned UTF-8 */
} kolm_k_score_t;

/** Top-level manifest mirror of the v1.0 schema. */
typedef struct kolm_manifest_s {
  /* Required fields, spec §3. */
  char *spec;                      /**< MUST equal "kolm-1" */
  char *format_version;            /**< MUST equal "1.0" for v1.0 artifacts */
  char *job_id;
  char *task;
  char *created_at;                /**< ISO-8601 */
  char *runtime;                   /**< alias of runtime_target */
  kolm_runtime_target_t runtime_target;
  kolm_artifact_class_t artifact_class;
  char *base_model;
  kolm_tier_t tier;
  char *judge_id;
  double eval_score;               /**< [0, 1], 4-decimal */
  int64_t recipes_n;
  char recipes_registry_hash[KOLM_SHA256_BUF_LEN];
  int64_t evals_n;
  char *evals_spec;
  char evals_hash[KOLM_SHA256_BUF_LEN];
  kolm_seed_provenance_t seed_provenance;
  kolm_hashes_t hashes;
  char cid[KOLM_SHA256_BUF_LEN];
  kolm_policy_t policy;
  kolm_binary_entry_t *binaries;
  size_t binaries_len;
  int compiled_binary;             /**< -1 = null, 0 = false, 1 = true */
  bool production_ready;
  int64_t memory_requirement_mb;
  bool offline_capable;
  char *license;

  /* Optional / conditional blocks — NULL when absent per W460 rule. */
  kolm_attestation_block_t *confidential_compute;
  kolm_sustainability_badge_t *sustainability_badge;  /**< reserved, v1.1+ */
  kolm_k_score_t *k_score;
  char *parent_cid;                /**< W739 lineage */
  char *region;                    /**< W769 residency */
  char *output_schema_json;        /**< W809 canonicalized schema, raw JSON */
  char *output_schema_spec_version;
  char *guardrails_json;           /**< W736 rules, raw JSON */
  char *sparsity_profile_json;     /**< W721 TSAC, raw JSON */
  char *kv_profile_json;           /**< W722 ITKV, raw JSON */
  char *mixed_precision_profile_json; /**< W719 DAQ, raw JSON */

  /* artifact_hash recorded in the manifest; readers MUST recompute and
   * compare. Bound to receipt.artifact_hash. */
  char artifact_hash[KOLM_SHA256_BUF_LEN];
} kolm_manifest_t;

/** Per-step entry in receipt.chain. */
typedef struct kolm_chain_step_s {
  char *step;                      /**< "task" | "seeds" | "recipes" | "evals" | "bundle" */
  char input_hash[KOLM_SHA256_BUF_LEN];
  char output_hash[KOLM_SHA256_BUF_LEN];
  char hmac[KOLM_SHA256_BUF_LEN];
} kolm_chain_step_t;

/** Per-file row in receipt.artifact_files[]. */
typedef struct kolm_artifact_file_s {
  char *filename;
  char sha256[KOLM_SHA256_BUF_LEN];
} kolm_artifact_file_t;

/** Build toolchain block per receipt.build_toolchain. */
typedef struct kolm_build_toolchain_s {
  char *node_version;
  char *platform;
  char *arch;
  char *kolm_version;
  char *runtime_target;
  char *signed_at;
} kolm_build_toolchain_t;

/** Top-level receipt mirror of the v1.0 schema. */
typedef struct kolm_receipt_s {
  char *kolm_version;              /**< "0.1" */
  char *receipt_id;                /**< UUID */
  char cid[KOLM_SHA256_BUF_LEN];
  char artifact_hash[KOLM_SHA256_BUF_LEN];
  char eval_set_hash[KOLM_SHA256_BUF_LEN];
  double eval_score;
  char *judge_id;
  kolm_tier_t tier;
  kolm_chain_step_t *chain;
  size_t chain_len;
  char **event_source_hashes;
  size_t event_source_hashes_len;
  char *dataset_hash;              /**< NULL when self_generated */
  char *train_hash;
  char *holdout_hash;
  int64_t split_seed;              /**< -1 when null */
  char *runtime_target;
  kolm_artifact_file_t *artifact_files;
  size_t artifact_files_len;
  kolm_build_toolchain_t build_toolchain;
  kolm_signature_alg_t signature_alg;
  char *signed_at;
  char *signed_by;
  char *signature;                 /**< HMAC-SHA256 hex */
  char *signature_ed25519_json;    /**< raw JSON of the Ed25519 block, NULL when absent */
  char *signature_sigstore_json;   /**< raw JSON of the Sigstore bundle, NULL when absent */
} kolm_receipt_t;

/* ---------------------------------------------------------------------
 * Parse + validate prototypes. Implementations live in user code; this
 * header defines only the contract.
 * --------------------------------------------------------------------- */

/**
 * Parse a manifest.json buffer into a kolm_manifest_t.
 *
 * @param json_bytes  UTF-8 JSON buffer (not required to be NUL-terminated).
 * @param json_len    Length in bytes of json_bytes.
 * @param out         Caller-allocated manifest struct to populate.
 * @return KOLM_FORMAT_OK on success; otherwise an error code from
 *         kolm_format_error_t. On error, out is left in a partially-
 *         populated state and callers MUST call kolm_manifest_free.
 */
kolm_format_error_t kolm_manifest_parse(const char *json_bytes,
                                        size_t json_len,
                                        kolm_manifest_t *out);

/**
 * Parse a receipt.json buffer into a kolm_receipt_t. Same contract as
 * kolm_manifest_parse.
 */
kolm_format_error_t kolm_receipt_parse(const char *json_bytes,
                                       size_t json_len,
                                       kolm_receipt_t *out);

/**
 * Validate a manifest against the v1.0 schema. Performs:
 *   - required-field presence check
 *   - enum-value validation for artifact_class, runtime_target, tier
 *   - sha256 hex format check on every hash field
 *   - spec == "kolm-1" + format_version semver-compatible with "1.0"
 *   - policy consistency (require_ed25519 ↔ ed25519 block present)
 *
 * @param m   parsed manifest.
 * @return KOLM_FORMAT_OK when valid; otherwise the first failing error.
 */
kolm_format_error_t kolm_manifest_validate(const kolm_manifest_t *m);

/**
 * Recompute artifact_hash from a manifest and compare against the
 * declared value. Implements spec §5 (canonical JSON of conditional
 * slots, sha256, hex-encoded).
 *
 * @param m              parsed manifest.
 * @param recomputed_out optional caller-allocated buffer of
 *                       KOLM_SHA256_BUF_LEN bytes. When non-NULL, the
 *                       recomputed hash is written here.
 * @return KOLM_FORMAT_OK when recomputed equals m->artifact_hash;
 *         KOLM_FORMAT_ERR_HASH_MISMATCH otherwise.
 */
kolm_format_error_t kolm_artifact_hash_recompute(const kolm_manifest_t *m,
                                                 char *recomputed_out);

/**
 * Free all heap allocations owned by a manifest. Safe to call on a
 * zero-initialized struct (no-op).
 */
void kolm_manifest_free(kolm_manifest_t *m);

/**
 * Free all heap allocations owned by a receipt. Safe to call on a
 * zero-initialized struct (no-op).
 */
void kolm_receipt_free(kolm_receipt_t *r);

/**
 * Decode an artifact_class enum value to its canonical string form. The
 * returned pointer references static storage and MUST NOT be freed.
 */
const char *kolm_artifact_class_name(kolm_artifact_class_t v);

/**
 * Decode a runtime_target enum value to its canonical string form. The
 * returned pointer references static storage and MUST NOT be freed.
 */
const char *kolm_runtime_target_name(kolm_runtime_target_t v);

/**
 * Decode a tier enum value to its canonical string form. The returned
 * pointer references static storage and MUST NOT be freed.
 */
const char *kolm_tier_name(kolm_tier_t v);

/**
 * Decode a signature_alg enum value to its canonical string form. The
 * returned pointer references static storage and MUST NOT be freed.
 */
const char *kolm_signature_alg_name(kolm_signature_alg_t v);

/**
 * Decode an attestation_kind enum value to its canonical string form.
 * The returned pointer references static storage and MUST NOT be freed.
 */
const char *kolm_attestation_kind_name(kolm_attestation_kind_t v);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* KOLM_FORMAT_H */
